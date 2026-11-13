#define _GNU_SOURCE
#include <errno.h>
#include <node_api.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <unistd.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>

/* Node starts with about 570 MiB of data segment (V8 reserves its heap address space as writable memory), so the memory limit is what the process holds
 * now plus `extraBytes`, read from /proc/self/statm before the filter goes on. */
static int current_data_bytes(double *out) {
  FILE *statm = fopen("/proc/self/statm", "r");
  unsigned long size, resident, shared, text, lib, data;
  if (!statm) return -1;
  int read = fscanf(statm, "%lu %lu %lu %lu %lu %lu", &size, &resident, &shared, &text, &lib, &data);
  fclose(statm);
  if (read != 6) return -1;
  *out = (double)data * (double)sysconf(_SC_PAGESIZE);
  return 0;
}

/* The kernel half of the sandbox that reads the text of a file someone sent (C-63, #1382). The child process loads this first, before it touches the
 * file, and calls confine(extraBytes, cpuSeconds): from then on it can make no socket that is not a Unix one (so no network, whatever Node module a parser
 * reaches for), cannot exec or trace anything or use io_uring (which would carry a socket past this filter), and is bound by the kernel in memory (data
 * segment: every private writable mapping), CPU time, file size, open files and core size. It cannot be undone: no_new_privs, and a seccomp filter that
 * every thread has. Linux x86-64 and arm64 only; any other architecture does not build, so the sandbox is never silently missing. */
#if defined(__x86_64__)
#define FLUX_ARCH AUDIT_ARCH_X86_64
#elif defined(__aarch64__)
#define FLUX_ARCH AUDIT_ARCH_AARCH64
#else
#error "The file-text sandbox supports x86-64 and arm64 only"
#endif

#define DENY(nr) BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (nr), 0, 1), BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | (EPERM & SECCOMP_RET_DATA))

static napi_value fail(napi_env env, const char *message) {
  napi_throw_error(env, NULL, message);
  return NULL;
}

static napi_value confine(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  double extra = 0, cpu = 0, base = 0;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 2 || napi_get_value_double(env, argv[0], &extra) != napi_ok
      || napi_get_value_double(env, argv[1], &cpu) != napi_ok || extra < 1048576 || cpu < 1)
    return fail(env, "confine(extraBytes, cpuSeconds)");
  if (current_data_bytes(&base) != 0) return fail(env, "cannot read /proc/self/statm");

  struct rlimit limit;
  limit.rlim_cur = limit.rlim_max = (rlim_t)(base + extra);
  if (setrlimit(RLIMIT_DATA, &limit) != 0) return fail(env, "setrlimit(RLIMIT_DATA) failed");
  limit.rlim_cur = (rlim_t)cpu; limit.rlim_max = (rlim_t)cpu + 5;
  if (setrlimit(RLIMIT_CPU, &limit) != 0) return fail(env, "setrlimit(RLIMIT_CPU) failed");
  limit.rlim_cur = limit.rlim_max = 0;
  if (setrlimit(RLIMIT_FSIZE, &limit) != 0 || setrlimit(RLIMIT_CORE, &limit) != 0) return fail(env, "setrlimit(RLIMIT_FSIZE) failed");
  limit.rlim_cur = limit.rlim_max = 64;
  if (setrlimit(RLIMIT_NOFILE, &limit) != 0) return fail(env, "setrlimit(RLIMIT_NOFILE) failed");

  struct sock_filter program[] = {
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, FLUX_ARCH, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
    /* socket(domain, …): only AF_UNIX. */
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_socket, 0, 4),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AF_UNIX, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | (EACCES & SECCOMP_RET_DATA)),
    DENY(SYS_execve), DENY(SYS_execveat), DENY(SYS_ptrace), DENY(SYS_process_vm_readv), DENY(SYS_process_vm_writev),
    DENY(SYS_io_uring_setup), DENY(SYS_io_uring_enter), DENY(SYS_io_uring_register), DENY(SYS_bpf), DENY(SYS_perf_event_open),
    DENY(SYS_mount), DENY(SYS_umount2), DENY(SYS_unshare), DENY(SYS_setns), DENY(SYS_kexec_load), DENY(SYS_open_by_handle_at),
    DENY(SYS_userfaultfd), DENY(SYS_keyctl), DENY(SYS_add_key), DENY(SYS_request_key),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
  };
  struct sock_fprog fprog = { .len = (unsigned short)(sizeof(program) / sizeof(program[0])), .filter = program };
  if (prctl(PR_SET_NO_NEW_PRIVS, 1L, 0L, 0L, 0L) != 0) return fail(env, "PR_SET_NO_NEW_PRIVS failed");
  if (syscall(SYS_seccomp, SECCOMP_SET_MODE_FILTER, SECCOMP_FILTER_FLAG_TSYNC, &fprog) != 0) return fail(env, "seccomp filter refused");
  napi_value done;
  napi_get_boolean(env, 1, &done);
  return done;
}

NAPI_MODULE_INIT() {
  napi_value fn;
  if (napi_create_function(env, "confine", NAPI_AUTO_LENGTH, confine, NULL, &fn) != napi_ok) return NULL;
  if (napi_set_named_property(env, exports, "confine", fn) != napi_ok) return NULL;
  return exports;
}
