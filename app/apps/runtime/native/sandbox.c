/*
 * Flux's per-run sandbox for an agent's own tools (#1437, RT-5): the shell a CLI's built-in tools run in, and the reader that hands
 * a file of the run's scratch to `flux_attach_file`. No capability is needed: Landlock, rlimits, nice and a higher OOM score are all
 * things a process may do to itself. Everything it starts inherits them, and nothing it starts can undo them.
 *
 *   flux-sandbox cli <scratch> [--home <dir>]... [--read <dir>]... [--exec <path>]... -- <cli> <args>
 *                                (as the person) the CLI itself, under a domain that lets it write only its own homes and the
 *                                run's scratch and read only those, `--read` directories and the system: never another CLI's home.
 *                                It may run nothing but its own program (with the loader or interpreter that program names) and
 *                                this sandbox: whatever shell a model names, the kernel refuses to start it (EACCES). This is the
 *                                one way in for a command: the sandbox under the names bash and sh hands it to the broker.
 *   flux-sandbox broker <scratch> <socket>
 *                                (as the person, started by the supervisor beside the CLI, outside the CLI's domain) listens on the
 *                                Unix socket <socket>, prints "ready", then confines itself exactly as the tools are confined and
 *                                starts each shell asked for there: the real /bin/bash or /bin/sh in the run's scratch, with the
 *                                asker's standard input, output and error, in a session of its own. Its exit status goes back.
 *   bash|sh <args>               (as the person, through the name of a link, inside the CLI's domain) asks the broker named by
 *                                FLUX_SANDBOX_BROKER for that shell, passes on the signals it gets, and ends as the shell ended.
 *                                The shell is confined to the run's scratch FLUX_SANDBOX_DIR: read and write only there, read and
 *                                run the system's own programs, no TCP at all (Landlock ABI 4, which the shell requires), no socket
 *                                of any kind (seccomp: no UDP or DNS, which Landlock does not cover, and no Unix socket by path, which
 *                                Landlock does not see either), no io_uring, no signal or abstract socket outside it (ABI 6), a clean
 *                                environment, lower priority and the per-run limits below.
 *   flux-sandbox read <dir> <path> <max>   (as the person) writes the regular file <path> of the scratch <dir> to stdout, if it has
 *                                at most <max> bytes, reading under a Landlock domain that holds that directory only.
 *   flux-sandbox abi             prints the kernel's Landlock ABI version (0: none), for the supervisor's start.
 *
 * Exit codes of `read`: 0 sent, 2 no such file, 3 not a regular file, 4 too large, 5 no sandbox on this kernel, 1 anything else.
 * The shell never runs without its sandbox: anything it cannot set up ends it with 126 and one line on stderr.
 * This program is linked statically, so that the CLI's domain needs no loader to start it.
 */
#define _GNU_SOURCE
#include <elf.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/signalfd.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>

#ifndef SYS_io_uring_setup
#define SYS_io_uring_setup 425
#endif
#ifndef SYS_landlock_create_ruleset
#define SYS_landlock_create_ruleset 444
#define SYS_landlock_add_rule 445
#define SYS_landlock_restrict_self 446
#endif

/* The Landlock UAPI (include/uapi/linux/landlock.h), spelled out so that older kernel headers still build this. */
#define LL_CREATE_RULESET_VERSION (1U << 0)
#define LL_RULE_PATH_BENEATH 1
#define FS_EXECUTE (1ULL << 0)
#define FS_WRITE_FILE (1ULL << 1)
#define FS_READ_FILE (1ULL << 2)
#define FS_READ_DIR (1ULL << 3)
#define FS_REMOVE_DIR (1ULL << 4)
#define FS_REMOVE_FILE (1ULL << 5)
#define FS_MAKE_CHAR (1ULL << 6)
#define FS_MAKE_DIR (1ULL << 7)
#define FS_MAKE_REG (1ULL << 8)
#define FS_MAKE_SOCK (1ULL << 9)
#define FS_MAKE_FIFO (1ULL << 10)
#define FS_MAKE_BLOCK (1ULL << 11)
#define FS_MAKE_SYM (1ULL << 12)
#define FS_REFER (1ULL << 13)
#define FS_TRUNCATE (1ULL << 14)
#define FS_IOCTL_DEV (1ULL << 15)
#define NET_BIND_TCP (1ULL << 0)
#define NET_CONNECT_TCP (1ULL << 1)
#define SCOPE_ABSTRACT_UNIX (1ULL << 0)
#define SCOPE_SIGNAL (1ULL << 1)

/* Seccomp's classic BPF (include/uapi/linux/filter.h, seccomp.h, audit.h), spelled out for the same reason. */
struct sock_filter { uint16_t code; uint8_t jt; uint8_t jf; uint32_t k; };
struct sock_fprog { unsigned short len; struct sock_filter *filter; };
#define BPF_STMT(code, k) { (uint16_t)(code), 0, 0, (uint32_t)(k) }
#define BPF_JUMP(code, k, jt, jf) { (uint16_t)(code), (jt), (jf), (uint32_t)(k) }
#define BPF_LD_W_ABS 0x20 /* BPF_LD | BPF_W | BPF_ABS */
#define BPF_JEQ_K 0x15    /* BPF_JMP | BPF_JEQ | BPF_K */
#define BPF_JGE_K 0x35    /* BPF_JMP | BPF_JGE | BPF_K */
#define BPF_RET_K 0x06    /* BPF_RET | BPF_K */
#define SECCOMP_MODE_FILTER_ 2
#define SECCOMP_RET_KILL_PROCESS_ 0x80000000U
#define SECCOMP_RET_ERRNO_ 0x00050000U
#define SECCOMP_RET_ALLOW_ 0x7fff0000U
#define SECCOMP_DATA_NR 0   /* offsetof(struct seccomp_data, nr) */
#define SECCOMP_DATA_ARCH 4 /* offsetof(struct seccomp_data, arch) */
#if defined(__x86_64__)
#define FLUX_AUDIT_ARCH 0xC000003EU /* AUDIT_ARCH_X86_64 */
#elif defined(__aarch64__)
#define FLUX_AUDIT_ARCH 0xC00000B7U /* AUDIT_ARCH_AARCH64 */
#else
#error "Flux's sandbox knows the system calls of x86_64 and aarch64 only"
#endif

struct ruleset_attr { uint64_t handled_access_fs; uint64_t handled_access_net; uint64_t scoped; };
struct path_beneath_attr { uint64_t allowed_access; int32_t parent_fd; } __attribute__((packed));

/* What one run's tools may use (docs/operations/agent-runtime.md "What each agent needs"). */
#define SCRATCH_PREFIX "/scratch/"
#define FILE_BYTES (256ULL * 1024 * 1024) /* one file: the scratch's own size */
#define TASKS 256                          /* processes and threads of the person at once */
#define CPU_SECONDS 600                    /* of one process; the run's wall clock bounds the rest */
#define NICE 10
#define OOM_SCORE_ADJ "500"

/* Everything in a directory but devices, links and moving things in from elsewhere (REFER is never granted). */
#define WORK_RIGHTS (FS_EXECUTE | FS_WRITE_FILE | FS_READ_FILE | FS_READ_DIR | FS_REMOVE_DIR | FS_REMOVE_FILE | FS_MAKE_DIR | FS_MAKE_REG \
  | FS_MAKE_SOCK | FS_MAKE_FIFO | FS_TRUNCATE | FS_IOCTL_DEV)
#define READ_RIGHTS (FS_EXECUTE | FS_READ_FILE | FS_READ_DIR)
static const uint64_t FILE_RIGHTS = FS_EXECUTE | FS_WRITE_FILE | FS_READ_FILE | FS_TRUNCATE | FS_IOCTL_DEV;

static int fail(const char *what) {
  fprintf(stderr, "flux sandbox: %s%s%s\n", what, errno ? ": " : "", errno ? strerror(errno) : "");
  return 126;
}

static int abi_version(void) {
  long abi = syscall(SYS_landlock_create_ruleset, NULL, 0, LL_CREATE_RULESET_VERSION);
  return abi < 0 ? 0 : (int)abi;
}

static uint64_t handled_fs(int abi) {
  uint64_t fs = (FS_MAKE_SYM << 1) - 1; /* ABI 1: EXECUTE … MAKE_SYM */
  if (abi >= 2) fs |= FS_REFER;
  if (abi >= 3) fs |= FS_TRUNCATE;
  if (abi >= 5) fs |= FS_IOCTL_DEV;
  return fs;
}

/* A rule for `path` when it exists; a file gets only the rights a file can have. */
static int allow(int ruleset, const char *path, uint64_t access, uint64_t handled) {
  int fd = open(path, O_PATH | O_CLOEXEC);
  if (fd < 0) return errno == ENOENT ? 0 : -1;
  struct stat st;
  if (fstat(fd, &st) != 0) { close(fd); return -1; }
  if (!S_ISDIR(st.st_mode)) access &= FILE_RIGHTS;
  struct path_beneath_attr rule = { .allowed_access = access & handled, .parent_fd = fd };
  long done = rule.allowed_access ? syscall(SYS_landlock_add_rule, ruleset, LL_RULE_PATH_BENEATH, &rule, 0) : 0;
  close(fd);
  return done < 0 ? -1 : 0;
}

/* The run's scratch: /scratch/<one name>, a real directory of this user's, mode 0700. */
static int scratch_ok(const char *dir) {
  size_t prefix = strlen(SCRATCH_PREFIX);
  if (!dir || strncmp(dir, SCRATCH_PREFIX, prefix) != 0) return 0;
  const char *name = dir + prefix;
  size_t length = strlen(name);
  if (length == 0 || length > 64 || strspn(name, "abcdefghijklmnopqrstuvwxyz0123456789-") != length) return 0;
  struct stat st;
  if (lstat(dir, &st) != 0 || !S_ISDIR(st.st_mode) || st.st_uid != getuid() || (st.st_mode & 07777) != 0700) return 0;
  return 1;
}

/* One Landlock domain: `writable` (the scratch) with `writable_access`; the system's programs and libraries with `system_access` (0: not
 * at all), /proc to read and a few devices then; `extra` directories and files with their own rights; with `offline`, no TCP and no signal
 * or abstract socket outside. A right a rule does not grant is refused everywhere: the CLI's domain grants EXECUTE on single files only. */
#define MAX_EXTRA 16
struct grant { const char *path; uint64_t access; };

static int confine(const char *writable, uint64_t writable_access, uint64_t system_access, int offline, const struct grant *extra, size_t extras) {
  int abi = abi_version();
  if (abi < 1) { errno = 0; return -2; }
  struct ruleset_attr attr = { .handled_access_fs = handled_fs(abi) };
  size_t size = sizeof(uint64_t);
  if (offline && abi >= 4) { attr.handled_access_net = NET_BIND_TCP | NET_CONNECT_TCP; size = 2 * sizeof(uint64_t); }
  if (offline && abi >= 6) { attr.scoped = SCOPE_ABSTRACT_UNIX | SCOPE_SIGNAL; size = sizeof(attr); }
  int ruleset = (int)syscall(SYS_landlock_create_ruleset, &attr, size, 0);
  if (ruleset < 0) return -1;
  const uint64_t fs = attr.handled_access_fs;
  int bad = allow(ruleset, writable, writable_access, fs);
  for (size_t i = 0; i < extras; i += 1) bad |= allow(ruleset, extra[i].path, extra[i].access, fs);
  if (system_access) {
    static const char *const programs[] = { "/bin", "/sbin", "/usr", "/lib", "/etc" };
    for (size_t i = 0; i < sizeof(programs) / sizeof(*programs); i += 1) bad |= allow(ruleset, programs[i], system_access, fs);
    bad |= allow(ruleset, "/proc", FS_READ_FILE | FS_READ_DIR, fs);
    static const char *const devices[] = { "/dev/null", "/dev/zero", "/dev/full", "/dev/random", "/dev/urandom" };
    for (size_t i = 0; i < sizeof(devices) / sizeof(*devices); i += 1) bad |= allow(ruleset, devices[i], FS_READ_FILE | FS_WRITE_FILE, fs);
  }
  if (bad || prctl(PR_SET_NO_NEW_PRIVS, 1L, 0L, 0L, 0L) != 0 || syscall(SYS_landlock_restrict_self, ruleset, 0) != 0) { close(ruleset); return -1; }
  close(ruleset);
  return 0;
}

/*
 * The files a program needs the right to execute when it starts (#1437): the program itself, the loader its ELF header names (PT_INTERP;
 * none for a static program such as the pinned Codex or this sandbox), and for a script the interpreter its `#!` line names, with that
 * one's loader. Nothing else: each is a rule on that one file, so no other program of the system can be started.
 */
static size_t starts_with(const char *path, struct grant *out, size_t room, int depth) {
  static char names[6][256];
  static size_t used = 0;
  if (room == 0 || depth > 1 || used >= sizeof(names) / sizeof(*names)) return 0;
  size_t count = 0;
  out[count++] = (struct grant){ path, FS_EXECUTE | FS_READ_FILE };
  int fd = open(path, O_RDONLY | O_CLOEXEC);
  if (fd < 0) return count;
  unsigned char head[256];
  ssize_t got = pread(fd, head, sizeof(head) - 1, 0);
  if (got >= 2 && head[0] == '#' && head[1] == '!') {
    head[got] = 0;
    char *start = (char *)head + 2;
    while (*start == ' ' || *start == '\t') start += 1;
    size_t length = strcspn(start, " \t\n");
    if (length > 0 && length < sizeof(names[0]) && start[0] == '/' && used < sizeof(names) / sizeof(*names)) {
      char *name = names[used++];
      memcpy(name, start, length);
      name[length] = 0;
      count += starts_with(name, out + count, room - count, depth + 1);
    }
  } else if (got >= (ssize_t)sizeof(Elf64_Ehdr) && memcmp(head, ELFMAG, SELFMAG) == 0 && head[EI_CLASS] == ELFCLASS64) {
    Elf64_Ehdr header;
    memcpy(&header, head, sizeof(header));
    for (unsigned i = 0; i < header.e_phnum && i < 64; i += 1) {
      Elf64_Phdr program;
      if (pread(fd, &program, sizeof(program), (off_t)(header.e_phoff + (uint64_t)i * header.e_phentsize)) != (ssize_t)sizeof(program)) break;
      if (program.p_type != PT_INTERP || program.p_filesz < 2 || program.p_filesz > sizeof(names[0])) continue;
      if (used >= sizeof(names) / sizeof(*names)) break;
      char *name = names[used++];
      if (pread(fd, name, program.p_filesz, (off_t)program.p_offset) != (ssize_t)program.p_filesz || name[program.p_filesz - 1] != 0 || name[0] != '/') break;
      if (count < room) out[count++] = (struct grant){ name, FS_EXECUTE | FS_READ_FILE };
      break;
    }
  }
  close(fd);
  return count;
}

static int set_limit(int resource, rlim_t soft, rlim_t hard) {
  struct rlimit current;
  if (getrlimit(resource, &current) != 0) return -1;
  /* Never above what it already has: a process may only lower its own limits. */
  if (current.rlim_max != RLIM_INFINITY && hard > current.rlim_max) hard = current.rlim_max;
  if (soft > hard) soft = hard;
  struct rlimit next = { soft, hard };
  return setrlimit(resource, &next);
}

/*
 * No socket at all for the tools (#1437 review): Landlock (ABI 4 to 7) forbids TCP but not UDP, so without this a tool could still ask
 * the container's DNS or send datagrams on the runtime's network; nor does it see connect() to a Unix socket by its path, such as a CLI's
 * own messaging socket in its TMPDIR, which is the scratch. `socketpair` (anonymous, what pipes between programs use) stays. io_uring
 * could open and connect sockets past this filter, so it is gone too. Another architecture's system calls end the process. A socket asked
 * for gets EAFNOSUPPORT, which C libraries take as "no such thing here" (musl's passwd lookup, for one, then goes on without nscd).
 */
static int no_sockets(void) {
  struct sock_filter filter[] = {
    BPF_STMT(BPF_LD_W_ABS, SECCOMP_DATA_ARCH),
    BPF_JUMP(BPF_JEQ_K, FLUX_AUDIT_ARCH, 1, 0),
    BPF_STMT(BPF_RET_K, SECCOMP_RET_KILL_PROCESS_),
    BPF_STMT(BPF_LD_W_ABS, SECCOMP_DATA_NR),
#if defined(__x86_64__)
    BPF_JUMP(BPF_JGE_K, 0x40000000U, 0, 1), /* the x32 ABI's numbers */
    BPF_STMT(BPF_RET_K, SECCOMP_RET_ERRNO_ | ENOSYS),
#endif
    BPF_JUMP(BPF_JEQ_K, SYS_socket, 0, 1),
    BPF_STMT(BPF_RET_K, SECCOMP_RET_ERRNO_ | EAFNOSUPPORT),
    BPF_JUMP(BPF_JEQ_K, SYS_io_uring_setup, 0, 1),
    BPF_STMT(BPF_RET_K, SECCOMP_RET_ERRNO_ | ENOSYS),
    BPF_STMT(BPF_RET_K, SECCOMP_RET_ALLOW_),
  };
  struct sock_fprog program = { (unsigned short)(sizeof(filter) / sizeof(*filter)), filter };
  /* PR_SET_NO_NEW_PRIVS is set already (confine). */
  return prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER_, &program, 0L, 0L);
}

/* The run's processes go first when memory runs out, before the supervisor. Under the CLI's domain (`cli`, which set it already)
 * /proc cannot be written any more, which is fine. */
static int raise_oom_score(void) {
  int oom = open("/proc/self/oom_score_adj", O_WRONLY | O_CLOEXEC);
  if (oom < 0) return -1;
  int done = write(oom, OOM_SCORE_ADJ, strlen(OOM_SCORE_ADJ)) < 0 ? -1 : 0;
  close(oom);
  return done;
}

/* Everything the tools are held by, applied by the broker to itself, so every shell it starts and everything that shell starts has it. */
static int confine_tools(const char *scratch) {
  /* First what needs /proc to be writable, then the domain that takes that away. */
  if (raise_oom_score() != 0 && errno != EACCES) return fail("cannot raise the OOM score");
  errno = 0;
  if (getpriority(PRIO_PROCESS, 0) < NICE && setpriority(PRIO_PROCESS, 0, NICE) != 0) return fail("cannot lower the priority");
  if (set_limit(RLIMIT_CORE, 0, 0) || set_limit(RLIMIT_FSIZE, FILE_BYTES, FILE_BYTES) || set_limit(RLIMIT_NPROC, TASKS, TASKS)
    || set_limit(RLIMIT_CPU, CPU_SECONDS, CPU_SECONDS + 10)) return fail("cannot set the limits");
  /* Tools only where Landlock forbids TCP (coordinator decision on #1437): on an older kernel a shell could tunnel through the egress. */
  if (abi_version() < 4) { errno = 0; return fail("this kernel's Landlock cannot forbid TCP (ABI 4, Linux 6.7), so the tools cannot run"); }
  int confined = confine(scratch, WORK_RIGHTS, READ_RIGHTS, 1, NULL, 0);
  if (confined == -2) return fail("this kernel has no Landlock, so the tools cannot run");
  if (confined != 0) return fail("cannot confine the tools to the run's scratch");
  if (no_sockets() != 0) return fail("cannot take sockets away from the tools");
  return 0;
}

/* The environment a shell gets: nothing of the CLI's (its home, its token, its proxy) reaches the tools; of the asker's, only these. */
static const char *const KEPT[] = { "TERM", "TZ", "COLUMNS", "LINES", "NO_COLOR" };
#define KEPT_COUNT (sizeof(KEPT) / sizeof(*KEPT))

/* The real shell, in the run's scratch, with a clean environment: `values` holds the asker's KEPT variables (NULL where it had none). */
static int exec_shell(const char *real, char **argv, const char *scratch, const char *const values[KEPT_COUNT]) {
  if (chdir(scratch) != 0 && errno != EACCES) return fail("cannot enter the run's scratch");
  char *environment[16];
  size_t count = 0;
  static char home[112], tmp[112], pairs[KEPT_COUNT][80];
  snprintf(home, sizeof(home), "HOME=%s", scratch);
  snprintf(tmp, sizeof(tmp), "TMPDIR=%s", scratch);
  environment[count++] = "PATH=/usr/local/bin:/usr/bin:/bin";
  environment[count++] = "LANG=C.UTF-8";
  environment[count++] = home;
  environment[count++] = tmp;
  for (size_t i = 0; i < KEPT_COUNT; i += 1) {
    if (!values[i] || strlen(values[i]) > 64) continue;
    snprintf(pairs[i], sizeof(pairs[i]), "%s=%s", KEPT[i], values[i]);
    environment[count++] = pairs[i];
  }
  environment[count] = NULL;
  argv[0] = (char *)real;
  execve(real, argv, environment);
  return fail("cannot start the shell");
}

/*
 * The broker (#1437, coordinator decision on the open risk of #1442). The CLI's domain may execute nothing but its own program and this
 * sandbox, so a shell can no longer start inside that domain: it is started here, by a process of the person outside it, which holds the
 * tools' own confinement already. One request per connection, from a process of the same person only:
 *   the first message: 4 bytes, the length of what follows, with the asker's standard input, output and error (SCM_RIGHTS);
 *   then that many bytes: NUL-ended strings, the number of arguments, the arguments (the first is "bash" or "sh"), then KEPT's values
 *   in order ("-" for none, or "=" and the value);
 *   then, while the shell runs, two bytes 'S' and a signal number for each signal to pass on to the shell's process group;
 * and the answer is the shell's wait status, 4 bytes. A connection that closes first ends the shell's process group.
 */
#define REQUEST_MAX (4U * 1024 * 1024)
#define ARGS_MAX 4096

static int read_all(int fd, void *buffer, size_t length) {
  for (size_t done = 0; done < length;) {
    ssize_t got = read(fd, (char *)buffer + done, length - done);
    if (got < 0 && errno == EINTR) continue;
    if (got <= 0) return -1;
    done += (size_t)got;
  }
  return 0;
}

static int write_all(int fd, const void *buffer, size_t length) {
  for (size_t done = 0; done < length;) {
    ssize_t put = write(fd, (const char *)buffer + done, length - done);
    if (put < 0 && errno == EINTR) continue;
    if (put <= 0) return -1;
    done += (size_t)put;
  }
  return 0;
}

static int passable(int sig) {
  return sig == SIGINT || sig == SIGTERM || sig == SIGHUP || sig == SIGQUIT || sig == SIGUSR1 || sig == SIGUSR2 || sig == SIGWINCH;
}

static void serve(int conn, const char *scratch) {
  struct ucred peer;
  socklen_t peer_size = sizeof(peer);
  if (getsockopt(conn, SOL_SOCKET, SO_PEERCRED, &peer, &peer_size) != 0 || peer.uid != getuid()) _exit(1);
  uint32_t length = 0;
  char control[CMSG_SPACE(3 * sizeof(int))];
  struct iovec part = { &length, sizeof(length) };
  struct msghdr message = { .msg_iov = &part, .msg_iovlen = 1, .msg_control = control, .msg_controllen = sizeof(control) };
  ssize_t got;
  do got = recvmsg(conn, &message, MSG_CMSG_CLOEXEC | MSG_WAITALL); while (got < 0 && errno == EINTR);
  struct cmsghdr *header = CMSG_FIRSTHDR(&message);
  if (got != (ssize_t)sizeof(length) || (message.msg_flags & MSG_CTRUNC) || !header || header->cmsg_level != SOL_SOCKET
    || header->cmsg_type != SCM_RIGHTS || header->cmsg_len != CMSG_LEN(3 * sizeof(int)) || length == 0 || length > REQUEST_MAX) _exit(1);
  int fds[3];
  memcpy(fds, CMSG_DATA(header), sizeof(fds));
  char *request = malloc((size_t)length + 1);
  if (!request || read_all(conn, request, length) != 0) _exit(1);
  request[length] = 0;
  if (request[length - 1] != 0) _exit(1);
  /* The strings: the count, the arguments, KEPT's values. */
  char *at = request, *end = request + length;
  char *count_text = at; at += strlen(at) + 1;
  char *tail = NULL;
  unsigned long argc = strtoul(count_text, &tail, 10);
  if (!tail || *tail || argc < 1 || argc > ARGS_MAX) _exit(1);
  char **argv = calloc(argc + 1, sizeof(char *));
  if (!argv) _exit(1);
  for (unsigned long i = 0; i < argc; i += 1) { if (at >= end) _exit(1); argv[i] = at; at += strlen(at) + 1; }
  const char *values[KEPT_COUNT] = { 0 };
  for (size_t i = 0; i < KEPT_COUNT; i += 1) {
    if (at >= end || (at[0] != '-' && at[0] != '=')) _exit(1);
    values[i] = at[0] == '=' ? at + 1 : NULL;
    at += strlen(at) + 1;
  }
  if (at != end) _exit(1);
  const char *real = strcmp(argv[0], "bash") == 0 ? "/bin/bash" : strcmp(argv[0], "sh") == 0 ? "/bin/sh" : NULL;
  if (!real) _exit(1);

  /* The broker's own SIGCHLD (ignored, children reaped by the kernel) is not the handler's: it waits for its shell. */
  signal(SIGCHLD, SIG_DFL);
  sigset_t child_set, previous;
  sigemptyset(&child_set);
  sigaddset(&child_set, SIGCHLD);
  sigprocmask(SIG_BLOCK, &child_set, &previous);
  int child_signals = signalfd(-1, &child_set, SFD_CLOEXEC);
  if (child_signals < 0) _exit(1);
  pid_t shell_pid = fork();
  if (shell_pid < 0) _exit(1);
  if (shell_pid == 0) {
    /* A session of its own; a terminal it was given stays its terminal for reading and writing (the asker's session owns it). */
    setsid();
    for (int i = 0; i < 3; i += 1) if (dup2(fds[i], i) < 0) _exit(126);
    signal(SIGCHLD, SIG_DFL);
    signal(SIGPIPE, SIG_DFL);
    sigprocmask(SIG_SETMASK, &previous, NULL);
    _exit(exec_shell(real, argv, scratch, values));
  }
  for (int i = 0; i < 3; i += 1) close(fds[i]);
  for (;;) {
    struct pollfd watch[2] = { { conn, POLLIN, 0 }, { child_signals, POLLIN, 0 } };
    if (poll(watch, 2, -1) < 0) { if (errno == EINTR) continue; break; }
    if (watch[1].revents) {
      struct signalfd_siginfo info;
      if (read(child_signals, &info, sizeof(info)) < 0 && errno != EAGAIN) break;
      int status = 0;
      pid_t done = waitpid(shell_pid, &status, WNOHANG);
      if (done == shell_pid) {
        uint32_t answer = (uint32_t)status;
        write_all(conn, &answer, sizeof(answer));
        _exit(0);
      }
    }
    if (watch[0].revents) {
      unsigned char asked[2];
      ssize_t read_now = read(conn, asked, sizeof(asked));
      if (read_now == 2 && asked[0] == 'S' && passable(asked[1])) { kill(-shell_pid, asked[1]); continue; }
      if (read_now < 0 && errno == EINTR) continue;
      break;
    }
  }
  /* The asker is gone (killed, or its CLI ended it): so is the shell and what it started in its session. */
  kill(-shell_pid, SIGKILL);
  kill(shell_pid, SIGKILL);
  waitpid(shell_pid, NULL, 0);
  _exit(1);
}

static int broker(const char *scratch_dir, const char *path) {
  if (!scratch_ok(scratch_dir)) { errno = 0; return fail("broker: the first argument must be the run's scratch directory"); }
  char scratch[96];
  snprintf(scratch, sizeof(scratch), "%s", scratch_dir);
  struct sockaddr_un address = { .sun_family = AF_UNIX };
  if (!path || path[0] != '/' || strlen(path) >= sizeof(address.sun_path)) { errno = 0; return fail("broker: the socket must be an absolute path"); }
  memcpy(address.sun_path, path, strlen(path) + 1);
  /* Made before the domain, which takes sockets away; nothing it starts inherits it. */
  int listener = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (listener < 0) return fail("broker: cannot make its socket");
  mode_t before = umask(0177);
  int bound = bind(listener, (struct sockaddr *)&address, sizeof(address));
  umask(before);
  if (bound != 0 || listen(listener, 64) != 0) return fail("broker: cannot listen");
  int confined = confine_tools(scratch);
  if (confined != 0) return confined;
  /* Handlers are reaped by the kernel; each one waits for its own shell. */
  struct sigaction ignore = { .sa_handler = SIG_IGN, .sa_flags = SA_NOCLDWAIT };
  sigaction(SIGCHLD, &ignore, NULL);
  signal(SIGPIPE, SIG_IGN);
  if (write_all(STDOUT_FILENO, "ready\n", 6) != 0) return fail("broker: cannot say it is ready");
  int quiet = open("/dev/null", O_RDWR | O_CLOEXEC);
  if (quiet >= 0) { dup2(quiet, STDIN_FILENO); dup2(quiet, STDOUT_FILENO); close(quiet); }
  for (;;) {
    int conn = accept4(listener, NULL, NULL, SOCK_CLOEXEC);
    if (conn < 0) { if (errno == EINTR || errno == ECONNABORTED || errno == EMFILE || errno == ENFILE || errno == EAGAIN) continue; return fail("broker: cannot accept"); }
    pid_t handler = fork();
    if (handler == 0) { close(listener); serve(conn, scratch); }
    close(conn);
  }
}

/* The shim: bash or sh inside the CLI's domain. It cannot start a shell there; it asks the broker for one and becomes its stand-in. */
static volatile sig_atomic_t broker_fd = -1;

static void pass_on(int sig) {
  unsigned char asked[2] = { 'S', (unsigned char)sig };
  int saved = errno;
  if (broker_fd >= 0) { ssize_t ignored = write(broker_fd, asked, sizeof(asked)); (void)ignored; }
  errno = saved;
}

static int shim(const char *name, int argc, char **argv) {
  const char *path = getenv("FLUX_SANDBOX_BROKER");
  struct sockaddr_un address = { .sun_family = AF_UNIX };
  if (!path || path[0] != '/' || strlen(path) >= sizeof(address.sun_path)) { errno = 0; return fail("no sandbox broker for this run (FLUX_SANDBOX_BROKER)"); }
  memcpy(address.sun_path, path, strlen(path) + 1);
  /* The request: the count, the arguments (the first is the shell's name), then KEPT's values. */
  size_t length = 0;
  char count_text[16];
  snprintf(count_text, sizeof(count_text), "%d", argc);
  length += strlen(count_text) + 1 + strlen(name) + 1;
  for (int i = 1; i < argc; i += 1) length += strlen(argv[i]) + 1;
  for (size_t i = 0; i < KEPT_COUNT; i += 1) { const char *value = getenv(KEPT[i]); length += (value ? strlen(value) + 1 : 1) + 1; }
  if (length > REQUEST_MAX) { errno = E2BIG; return fail("the command is too long"); }
  char *request = malloc(length), *at = request;
  if (!request) return fail("out of memory");
  #define PUT(text) do { size_t n_ = strlen(text) + 1; memcpy(at, (text), n_); at += n_; } while (0)
  PUT(count_text);
  PUT(name);
  for (int i = 1; i < argc; i += 1) PUT(argv[i]);
  for (size_t i = 0; i < KEPT_COUNT; i += 1) {
    const char *value = getenv(KEPT[i]);
    if (!value) { PUT("-"); continue; }
    *at++ = '=';
    PUT(value);
  }
  #undef PUT
  int conn = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (conn < 0 || connect(conn, (struct sockaddr *)&address, sizeof(address)) != 0) return fail("cannot reach the sandbox broker");
  /* Standard streams the CLI left closed are /dev/null for the shell. */
  int fds[3];
  for (int i = 0; i < 3; i += 1) fds[i] = fcntl(i, F_GETFD) < 0 ? open("/dev/null", O_RDWR | O_CLOEXEC) : i;
  uint32_t size = (uint32_t)length;
  char control[CMSG_SPACE(sizeof(fds))];
  memset(control, 0, sizeof(control));
  struct iovec part = { &size, sizeof(size) };
  struct msghdr message = { .msg_iov = &part, .msg_iovlen = 1, .msg_control = control, .msg_controllen = sizeof(control) };
  struct cmsghdr *header = CMSG_FIRSTHDR(&message);
  header->cmsg_level = SOL_SOCKET;
  header->cmsg_type = SCM_RIGHTS;
  header->cmsg_len = CMSG_LEN(sizeof(fds));
  memcpy(CMSG_DATA(header), fds, sizeof(fds));
  ssize_t sent;
  do sent = sendmsg(conn, &message, MSG_NOSIGNAL); while (sent < 0 && errno == EINTR);
  if (sent != (ssize_t)sizeof(size) || write_all(conn, request, length) != 0) return fail("cannot ask the sandbox broker");
  free(request);
  /* The signals this stand-in gets go to the shell's process group (an interrupt typed in its terminal, the CLI's stop). */
  broker_fd = conn;
  static const int passed[] = { SIGINT, SIGTERM, SIGHUP, SIGQUIT, SIGUSR1, SIGUSR2, SIGWINCH };
  struct sigaction on = { .sa_handler = pass_on, .sa_flags = SA_RESTART };
  sigemptyset(&on.sa_mask);
  for (size_t i = 0; i < sizeof(passed) / sizeof(*passed); i += 1) sigaction(passed[i], &on, NULL);
  signal(SIGPIPE, SIG_IGN);
  uint32_t answer = 0;
  if (read_all(conn, &answer, sizeof(answer)) != 0) return 128 + SIGKILL;
  int status = (int)answer;
  if (WIFEXITED(status)) return WEXITSTATUS(status);
  if (WIFSIGNALED(status)) {
    int sig = WTERMSIG(status);
    signal(sig, SIG_DFL);
    sigset_t only;
    sigemptyset(&only);
    sigaddset(&only, sig);
    sigprocmask(SIG_UNBLOCK, &only, NULL);
    raise(sig);
    return 128 + sig;
  }
  return 1;
}

/* A home of the person's CLI: a real directory of this user's, mode 0700, directly below their binding directory. */
static int home_ok(const char *dir) {
  if (!dir || strncmp(dir, "/data/", 6) != 0 || strstr(dir, "/..") || strlen(dir) > 200) return 0;
  struct stat st;
  return lstat(dir, &st) == 0 && S_ISDIR(st.st_mode) && st.st_uid == getuid() && (st.st_mode & 07777) == 0700;
}

static int cli(int argc, char **argv) {
  if (argc < 5 || !scratch_ok(argv[2])) { errno = 0; return fail("cli: the first argument must be the run's scratch directory"); }
  struct grant extra[MAX_EXTRA];
  size_t extras = 0;
  int at = 3;
  /* Nothing the CLI may write or read can be executed: its homes, the scratch and every directory are without EXECUTE (#1437). */
  for (; at + 1 < argc && strcmp(argv[at], "--") != 0; at += 2) {
    int home = strcmp(argv[at], "--home") == 0, readable = strcmp(argv[at], "--read") == 0;
    struct stat st;
    /* TEST ONLY (the check images' wrappers, FLUX_RUNTIME_TEST_EXEC): one more file or directory the CLI may execute. */
    if (strcmp(argv[at], "--exec") == 0) {
      if (extras < 6 && argv[at + 1][0] == '/' && stat(argv[at + 1], &st) == 0) extra[extras++] = (struct grant){ argv[at + 1], FS_EXECUTE | FS_READ_FILE | FS_READ_DIR };
      continue;
    }
    if (extras >= 6 || (!home && !readable)) { errno = 0; return fail("cli: unknown or too many options"); }
    if (home ? !home_ok(argv[at + 1]) : argv[at + 1][0] != '/' || lstat(argv[at + 1], &st) != 0 || !S_ISDIR(st.st_mode)) {
      errno = 0; return fail("cli: a directory is not what it must be");
    }
    extra[extras++] = (struct grant){ argv[at + 1], home ? (WORK_RIGHTS | FS_MAKE_SYM) & ~FS_EXECUTE : READ_RIGHTS & ~FS_EXECUTE };
  }
  if (at >= argc - 1 || strcmp(argv[at], "--") != 0 || argv[at + 1][0] != '/') { errno = 0; return fail("cli: no program after --"); }
  /* What the CLI itself reads besides its homes: its own program, the run's settings, /sys for its limits. */
  static const char *const readable[] = { "/opt", "/sys" };
  for (size_t i = 0; i < sizeof(readable) / sizeof(*readable); i += 1) extra[extras++] = (struct grant){ readable[i], READ_RIGHTS & ~FS_EXECUTE };
  /*
   * What it may execute (coordinator decision on #1437's open risk): its own program with what that program needs to start, and this
   * sandbox, which under the names bash and sh hands every command to the broker. A shell, interpreter or any other program a model
   * names (Codex 0.160.1's `exec_command` takes a `shell`) is refused by the kernel, so no command runs in this domain.
   */
  extras += starts_with(argv[at + 1], extra + extras, MAX_EXTRA - extras - 1, 0);
  extra[extras++] = (struct grant){ "/proc/self/exe", FS_EXECUTE | FS_READ_FILE };
  if (abi_version() < 4) { errno = 0; return fail("this kernel's Landlock cannot forbid TCP (ABI 4, Linux 6.7), so the CLI cannot run with its tools"); }
  if (raise_oom_score() != 0) return fail("cannot raise the OOM score");
  if (set_limit(RLIMIT_CORE, 0, 0)) return fail("cannot set the limits");
  int confined = confine(argv[2], WORK_RIGHTS & ~FS_EXECUTE, READ_RIGHTS & ~FS_EXECUTE, 0, extra, extras);
  if (confined == -2) return fail("this kernel has no Landlock, so the CLI cannot run with its tools");
  if (confined != 0) return fail("cannot confine the CLI");
  execv(argv[at + 1], argv + at + 1);
  return fail("cannot start the CLI");
}

static int read_file(const char *dir, const char *path, const char *max_text) {
  char *end = NULL;
  errno = 0;
  unsigned long long max = strtoull(max_text, &end, 10);
  if (errno || !end || *end || max == 0 || !scratch_ok(dir) || !*path || path[0] == '/') return 1;
  int root = open(dir, O_PATH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (root < 0) return 1;
  int confined = confine(dir, FS_READ_FILE | FS_READ_DIR, 0, 1, NULL, 0);
  if (confined == -2) return 5;
  if (confined != 0) return 1;
  /* A link as the last name is refused; a link before it can lead only where the domain lets it, inside the scratch. */
  int fd = openat(root, path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_NOCTTY | O_CLOEXEC);
  if (fd < 0) return errno == ENOENT || errno == ENOTDIR ? 2 : errno == ELOOP ? 3 : 1;
  struct stat st;
  if (fstat(fd, &st) != 0) return 1;
  if (!S_ISREG(st.st_mode)) return 3;
  if ((unsigned long long)st.st_size > max) return 4;
  char buffer[65536];
  unsigned long long sent = 0;
  for (;;) {
    ssize_t got = read(fd, buffer, sizeof(buffer));
    if (got < 0) { if (errno == EINTR) continue; return 1; }
    if (got == 0) break;
    /* It may still grow while it is read: never more than `max`. */
    if ((sent += (unsigned long long)got) > max) return 4;
    for (ssize_t off = 0; off < got;) {
      ssize_t put = write(STDOUT_FILENO, buffer + off, (size_t)(got - off));
      if (put < 0) { if (errno == EINTR) continue; return 1; }
      off += put;
    }
  }
  return 0;
}

int main(int argc, char **argv) {
  const char *name = strrchr(argv[0], '/');
  name = name ? name + 1 : argv[0];
  if (strcmp(name, "bash") == 0 || strcmp(name, "sh") == 0) return shim(name, argc, argv);
  if (argc == 2 && strcmp(argv[1], "abi") == 0) { printf("%d\n", abi_version()); return 0; }
  if (argc >= 2 && strcmp(argv[1], "cli") == 0) return cli(argc, argv);
  if (argc == 4 && strcmp(argv[1], "broker") == 0) return broker(argv[2], argv[3]);
  if (argc == 5 && strcmp(argv[1], "read") == 0) return read_file(argv[2], argv[3], argv[4]);
  fprintf(stderr, "usage: flux-sandbox abi | flux-sandbox cli <scratch> [--home|--read <dir>|--exec <path>]... -- <cli> <args> | flux-sandbox broker <scratch> <socket>"
    " | flux-sandbox read <scratch> <path> <max-bytes>, or as bash or sh\n");
  return 2;
}
