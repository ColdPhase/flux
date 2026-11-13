#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <node_api.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/landlock.h>
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
 * reaches for), cannot exec or trace anything or use io_uring (which would carry a socket past this filter), cannot open a file for writing nor create,
 * remove, rename, truncate or change the owner, mode or attributes of one, cannot take another process's descriptors (pidfd_getfd), and is bound by the
 * kernel in memory (data segment: every private writable mapping), CPU time, file size, open files and core size. It cannot be undone: no_new_privs, and a
 * seccomp filter that every thread has. These hold even where Node's permission model would be bypassed. Where the kernel has Landlock, the files it may
 * read are bound in the kernel too (confine's third argument: its code and PDF.js), so that such a bypass reads no other file either. The worker itself calls shield() once: it is then
 * not dumpable, so a child of the same user can read neither its environment (its secrets), its memory nor its descriptors through /proc.
 * Linux x86-64 and arm64 only; any other architecture does not build, so the sandbox is never silently missing. */
#if defined(__x86_64__)
#define FLUX_ARCH AUDIT_ARCH_X86_64
#elif defined(__aarch64__)
#define FLUX_ARCH AUDIT_ARCH_AARCH64
#else
#error "The file-text sandbox supports x86-64 and arm64 only"
#endif

/* A file opened with any of these could be written or emptied. */
#define WRITE_FLAGS (O_WRONLY | O_RDWR | O_CREAT | O_TRUNC)
/* x86-64's x32 system calls carry this bit under the same architecture: one would pass every number below unseen, so any such call kills the process. */
#define X32_SYSCALL_BIT 0x40000000

#define DENY(nr) BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (nr), 0, 1), BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | (EPERM & SECCOMP_RET_DATA))

static napi_value fail(napi_env env, const char *message) {
  napi_throw_error(env, NULL, message);
  return NULL;
}

/* Landlock (Linux 5.13 on): from now on this thread, and every thread it starts, reads only beneath `paths` and writes nowhere. Threads that exist
 * already (V8's own) are not bound; Node starts the threads that do file work later. Returns the ABI applied, 0 where the kernel or the container has no
 * Landlock (the seccomp filter and Node's permission model still hold there), or -1 when a ruleset was made but could not be applied. */
static int landlock(napi_env env, napi_value paths) {
#if !defined(SYS_landlock_create_ruleset)
  (void)env; (void)paths;
  return 0;
#else
  int abi = (int)syscall(SYS_landlock_create_ruleset, NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
  if (abi < 1) return 0;
  struct landlock_ruleset_attr attr = { 0 };
  attr.handled_access_fs = LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_WRITE_FILE | LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_READ_DIR
    | LANDLOCK_ACCESS_FS_REMOVE_DIR | LANDLOCK_ACCESS_FS_REMOVE_FILE | LANDLOCK_ACCESS_FS_MAKE_CHAR | LANDLOCK_ACCESS_FS_MAKE_DIR
    | LANDLOCK_ACCESS_FS_MAKE_REG | LANDLOCK_ACCESS_FS_MAKE_SOCK | LANDLOCK_ACCESS_FS_MAKE_FIFO | LANDLOCK_ACCESS_FS_MAKE_BLOCK
    | LANDLOCK_ACCESS_FS_MAKE_SYM;
  if (abi >= 2) attr.handled_access_fs |= LANDLOCK_ACCESS_FS_REFER;
  if (abi >= 3) attr.handled_access_fs |= LANDLOCK_ACCESS_FS_TRUNCATE;
#if defined(LANDLOCK_ACCESS_FS_IOCTL_DEV)
  if (abi >= 5) attr.handled_access_fs |= LANDLOCK_ACCESS_FS_IOCTL_DEV;
#endif
#if defined(LANDLOCK_SCOPE_ABSTRACT_UNIX_SOCKET)
  /* No abstract Unix socket and no signal outside this process. */
  if (abi >= 6) attr.scoped = LANDLOCK_SCOPE_ABSTRACT_UNIX_SOCKET | LANDLOCK_SCOPE_SIGNAL;
  size_t size = abi >= 6 ? sizeof(attr) : offsetof(struct landlock_ruleset_attr, scoped);
#else
  size_t size = sizeof(attr);
#endif
  int ruleset = (int)syscall(SYS_landlock_create_ruleset, &attr, size, 0);
  if (ruleset < 0) return 0;
  uint32_t count = 0;
  if (napi_get_array_length(env, paths, &count) != napi_ok) count = 0;
  for (uint32_t index = 0; index < count; index++) {
    napi_value item;
    char path[4096];
    size_t length = 0;
    if (napi_get_element(env, paths, index, &item) != napi_ok || napi_get_value_string_utf8(env, item, path, sizeof(path), &length) != napi_ok
        || length == 0 || length >= sizeof(path) - 1) continue;
    int fd = open(path, O_PATH | O_CLOEXEC);
    if (fd < 0) continue;
    struct stat info;
    struct landlock_path_beneath_attr rule = { .allowed_access = LANDLOCK_ACCESS_FS_READ_FILE, .parent_fd = fd };
    if (fstat(fd, &info) == 0 && S_ISDIR(info.st_mode)) rule.allowed_access |= LANDLOCK_ACCESS_FS_READ_DIR;
    syscall(SYS_landlock_add_rule, ruleset, LANDLOCK_RULE_PATH_BENEATH, &rule, 0);
    close(fd);
  }
  int applied = (int)syscall(SYS_landlock_restrict_self, ruleset, 0);
  close(ruleset);
  return applied == 0 ? abi : -1;
#endif
}

static napi_value confine(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
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
#if defined(__x86_64__)
    BPF_JUMP(BPF_JMP | BPF_JGE | BPF_K, X32_SYSCALL_BIT, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
#endif
    /* socket(domain, …): only AF_UNIX. */
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_socket, 0, 4),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AF_UNIX, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | (EACCES & SECCOMP_RET_DATA)),
    /* open/openat: read-only. openat2 takes its flags by pointer, which a filter cannot read, so it is refused (below). */
#if defined(SYS_open)
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_open, 0, 4),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[1])),
    BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, WRITE_FLAGS, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | (EACCES & SECCOMP_RET_DATA)),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
#endif
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_openat, 0, 4),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[2])),
    BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, WRITE_FLAGS, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | (EACCES & SECCOMP_RET_DATA)),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    /* Every way to change a file without opening it for writing; the ones only x86-64 has, and the newer ones, where the headers know them. */
    DENY(SYS_unlinkat), DENY(SYS_renameat2), DENY(SYS_mkdirat), DENY(SYS_symlinkat), DENY(SYS_linkat), DENY(SYS_mknodat), DENY(SYS_truncate),
    DENY(SYS_fchmod), DENY(SYS_fchmodat), DENY(SYS_fchown), DENY(SYS_fchownat), DENY(SYS_utimensat),
    DENY(SYS_setxattr), DENY(SYS_lsetxattr), DENY(SYS_fsetxattr), DENY(SYS_removexattr), DENY(SYS_lremovexattr), DENY(SYS_fremovexattr),
#if defined(SYS_open)
    DENY(SYS_creat), DENY(SYS_unlink), DENY(SYS_rename), DENY(SYS_mkdir), DENY(SYS_rmdir), DENY(SYS_symlink), DENY(SYS_link), DENY(SYS_mknod),
    DENY(SYS_chmod), DENY(SYS_chown), DENY(SYS_lchown), DENY(SYS_utime), DENY(SYS_utimes), DENY(SYS_futimesat),
#endif
#if defined(SYS_renameat)
    DENY(SYS_renameat),
#endif
#if defined(SYS_openat2)
    DENY(SYS_openat2),
#endif
#if defined(SYS_fchmodat2)
    DENY(SYS_fchmodat2),
#endif
#if defined(SYS_pidfd_getfd)
    DENY(SYS_pidfd_getfd),
#endif
#if defined(SYS_pidfd_open)
    DENY(SYS_pidfd_open),
#endif
#if defined(SYS_process_madvise)
    DENY(SYS_process_madvise),
#endif
    DENY(SYS_execve), DENY(SYS_execveat), DENY(SYS_ptrace), DENY(SYS_process_vm_readv), DENY(SYS_process_vm_writev),
    DENY(SYS_io_uring_setup), DENY(SYS_io_uring_enter), DENY(SYS_io_uring_register), DENY(SYS_bpf), DENY(SYS_perf_event_open),
    DENY(SYS_mount), DENY(SYS_umount2), DENY(SYS_unshare), DENY(SYS_setns), DENY(SYS_kexec_load), DENY(SYS_open_by_handle_at),
    DENY(SYS_userfaultfd), DENY(SYS_keyctl), DENY(SYS_add_key), DENY(SYS_request_key),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
  };
  struct sock_fprog fprog = { .len = (unsigned short)(sizeof(program) / sizeof(program[0])), .filter = program };
  if (prctl(PR_SET_NO_NEW_PRIVS, 1L, 0L, 0L, 0L) != 0) return fail(env, "PR_SET_NO_NEW_PRIVS failed");
  bool is_array = false;
  int bound = argc >= 3 && napi_is_array(env, argv[2], &is_array) == napi_ok && is_array ? landlock(env, argv[2]) : 0;
  if (bound < 0) return fail(env, "landlock_restrict_self failed");
  if (syscall(SYS_seccomp, SECCOMP_SET_MODE_FILTER, SECCOMP_FILTER_FLAG_TSYNC, &fprog) != 0) return fail(env, "seccomp filter refused");
  /* What was applied: the Landlock ABI that binds its reads (0 when the kernel has none). */
  napi_value done;
  napi_create_int32(env, bound, &done);
  return done;
}

/* The worker's own half: not dumpable, so that /proc/<worker>/environ, /proc/<worker>/mem and pidfd_getfd refuse a child of the same user. */
static napi_value shield(napi_env env, napi_callback_info info) {
  (void)info;
  if (prctl(PR_SET_DUMPABLE, 0L, 0L, 0L, 0L) != 0 || prctl(PR_GET_DUMPABLE, 0L, 0L, 0L, 0L) != 0) return fail(env, "PR_SET_DUMPABLE failed");
  napi_value done;
  napi_get_boolean(env, 1, &done);
  return done;
}

NAPI_MODULE_INIT() {
  napi_value fn;
  if (napi_create_function(env, "confine", NAPI_AUTO_LENGTH, confine, NULL, &fn) != napi_ok) return NULL;
  if (napi_set_named_property(env, exports, "confine", fn) != napi_ok) return NULL;
  if (napi_create_function(env, "shield", NAPI_AUTO_LENGTH, shield, NULL, &fn) != napi_ok) return NULL;
  if (napi_set_named_property(env, exports, "shield", fn) != napi_ok) return NULL;
  return exports;
}
