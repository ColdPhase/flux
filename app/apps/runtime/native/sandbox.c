/*
 * Flux's per-run sandbox for an agent's own tools (#1437, RT-5): the shell a CLI's built-in tools run in, and the reader that hands
 * a file of the run's scratch to `flux_attach_file`. No capability is needed: Landlock, rlimits, nice and a higher OOM score are all
 * things a process may do to itself. Everything it starts inherits them, and nothing it starts can undo them.
 *
 *   bash|sh <args>               (as the person, through the name of a link) the real /bin/bash or /bin/sh, confined to the run's
 *                                scratch FLUX_SANDBOX_DIR: read and write only there, read and run the system's own programs, no
 *                                TCP at all (Landlock ABI 4, which the shell requires), no socket of any kind (seccomp: no UDP or DNS,
 *                                which Landlock does not cover, and no Unix socket by path, which Landlock does not see either), no
 *                                io_uring, no signal or abstract socket outside it (ABI 6), a clean environment, lower priority and
 *                                the per-run limits below.
 *   flux-sandbox cli <scratch> [--home <dir>]... [--read <dir>]... -- <cli> <args>
 *                                (as the person) the CLI itself, under a domain that lets it write only its own homes and the
 *                                run's scratch and read only those, `--read` directories and the system: never another CLI's home.
 *   flux-sandbox read <dir> <path> <max>   (as the person) writes the regular file <path> of the scratch <dir> to stdout, if it has
 *                                at most <max> bytes, reading under a Landlock domain that holds that directory only.
 *   flux-sandbox abi             prints the kernel's Landlock ABI version (0: none), for the supervisor's start.
 *
 * Exit codes of `read`: 0 sent, 2 no such file, 3 not a regular file, 4 too large, 5 no sandbox on this kernel, 1 anything else.
 * The shell never runs without its sandbox: anything it cannot set up ends it with 126 and one line on stderr.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/syscall.h>
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

/* One Landlock domain: `writable` (the scratch) for everything but devices and links; with `system`, the system's programs and
 * libraries to read and run, /proc to read and a few devices; with `offline`, no TCP and no signal or abstract socket outside. */
#define MAX_EXTRA 8
struct grant { const char *path; uint64_t access; };

static int confine(const char *writable, uint64_t writable_access, int system, int offline, const struct grant *extra, size_t extras) {
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
  if (system) {
    static const char *const programs[] = { "/bin", "/sbin", "/usr", "/lib", "/etc" };
    for (size_t i = 0; i < sizeof(programs) / sizeof(*programs); i += 1) bad |= allow(ruleset, programs[i], FS_EXECUTE | FS_READ_FILE | FS_READ_DIR, fs);
    bad |= allow(ruleset, "/proc", FS_READ_FILE | FS_READ_DIR, fs);
    static const char *const devices[] = { "/dev/null", "/dev/zero", "/dev/full", "/dev/random", "/dev/urandom" };
    for (size_t i = 0; i < sizeof(devices) / sizeof(*devices); i += 1) bad |= allow(ruleset, devices[i], FS_READ_FILE | FS_WRITE_FILE, fs);
  }
  if (bad || prctl(PR_SET_NO_NEW_PRIVS, 1L, 0L, 0L, 0L) != 0 || syscall(SYS_landlock_restrict_self, ruleset, 0) != 0) { close(ruleset); return -1; }
  close(ruleset);
  return 0;
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

static int shell(const char *real, int argc, char **argv) {
  const char *dir = getenv("FLUX_SANDBOX_DIR");
  if (!scratch_ok(dir)) { errno = 0; return fail("FLUX_SANDBOX_DIR is not this run's scratch directory"); }
  char scratch[96];
  snprintf(scratch, sizeof(scratch), "%s", dir);
  /* First what needs /proc to be writable, then the domain that takes that away. */
  if (raise_oom_score() != 0 && errno != EACCES) return fail("cannot raise the OOM score");
  errno = 0;
  if (getpriority(PRIO_PROCESS, 0) < NICE && setpriority(PRIO_PROCESS, 0, NICE) != 0) return fail("cannot lower the priority");
  if (set_limit(RLIMIT_CORE, 0, 0) || set_limit(RLIMIT_FSIZE, FILE_BYTES, FILE_BYTES) || set_limit(RLIMIT_NPROC, TASKS, TASKS)
    || set_limit(RLIMIT_CPU, CPU_SECONDS, CPU_SECONDS + 10)) return fail("cannot set the limits");
  /* Tools only where Landlock forbids TCP (coordinator decision on #1437): on an older kernel a shell could tunnel through the egress. */
  if (abi_version() < 4) { errno = 0; return fail("this kernel's Landlock cannot forbid TCP (ABI 4, Linux 6.7), so the tools cannot run"); }
  int confined = confine(scratch, WORK_RIGHTS, 1, 1, NULL, 0);
  if (confined == -2) return fail("this kernel has no Landlock, so the tools cannot run");
  if (confined != 0) return fail("cannot confine the tools to the run's scratch");
  if (no_sockets() != 0) return fail("cannot take sockets away from the tools");
  if (chdir(scratch) != 0 && errno != EACCES) return fail("cannot enter the run's scratch");
  /* A clean environment: nothing of the CLI's (its home, its token, its proxy) reaches the tools. */
  static const char *const kept[] = { "TERM", "TZ", "COLUMNS", "LINES", "NO_COLOR" };
  char *environment[16];
  size_t count = 0;
  static char home[112], tmp[112];
  snprintf(home, sizeof(home), "HOME=%s", scratch);
  snprintf(tmp, sizeof(tmp), "TMPDIR=%s", scratch);
  environment[count++] = "PATH=/usr/local/bin:/usr/bin:/bin";
  environment[count++] = "LANG=C.UTF-8";
  environment[count++] = home;
  environment[count++] = tmp;
  for (size_t i = 0; i < sizeof(kept) / sizeof(*kept); i += 1) {
    const char *value = getenv(kept[i]);
    if (!value || strlen(value) > 64) continue;
    static char pairs[5][80];
    snprintf(pairs[i], sizeof(pairs[i]), "%s=%s", kept[i], value);
    environment[count++] = pairs[i];
  }
  environment[count] = NULL;
  argv[0] = (char *)real;
  (void)argc;
  execve(real, argv, environment);
  return fail("cannot start the shell");
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
  for (; at + 1 < argc && strcmp(argv[at], "--") != 0; at += 2) {
    int home = strcmp(argv[at], "--home") == 0, readable = strcmp(argv[at], "--read") == 0;
    struct stat st;
    if (extras == MAX_EXTRA || (!home && !readable)) { errno = 0; return fail("cli: unknown or too many options"); }
    if (home ? !home_ok(argv[at + 1]) : argv[at + 1][0] != '/' || lstat(argv[at + 1], &st) != 0 || !S_ISDIR(st.st_mode)) {
      errno = 0; return fail("cli: a directory is not what it must be");
    }
    extra[extras++] = (struct grant){ argv[at + 1], home ? WORK_RIGHTS | FS_MAKE_SYM : READ_RIGHTS };
  }
  if (at >= argc - 1 || strcmp(argv[at], "--") != 0 || argv[at + 1][0] != '/') { errno = 0; return fail("cli: no program after --"); }
  /* What the CLI itself reads besides its homes: its own program, the run's settings, /sys for its limits. */
  static const char *const readable[] = { "/opt", "/sys" };
  for (size_t i = 0; i < sizeof(readable) / sizeof(*readable) && extras < MAX_EXTRA; i += 1) extra[extras++] = (struct grant){ readable[i], READ_RIGHTS };
  if (abi_version() < 4) { errno = 0; return fail("this kernel's Landlock cannot forbid TCP (ABI 4, Linux 6.7), so the CLI cannot run with its tools"); }
  if (raise_oom_score() != 0) return fail("cannot raise the OOM score");
  if (set_limit(RLIMIT_CORE, 0, 0)) return fail("cannot set the limits");
  int confined = confine(argv[2], WORK_RIGHTS, 1, 0, extra, extras);
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
  if (strcmp(name, "bash") == 0) return shell("/bin/bash", argc, argv);
  if (strcmp(name, "sh") == 0) return shell("/bin/sh", argc, argv);
  if (argc == 2 && strcmp(argv[1], "abi") == 0) { printf("%d\n", abi_version()); return 0; }
  if (argc >= 2 && strcmp(argv[1], "cli") == 0) return cli(argc, argv);
  if (argc == 5 && strcmp(argv[1], "read") == 0) return read_file(argv[2], argv[3], argv[4]);
  fprintf(stderr, "usage: flux-sandbox abi | flux-sandbox cli <scratch> [--home|--read <dir>]... -- <cli> <args> | flux-sandbox read <scratch> <path> <max-bytes>, or as bash or sh\n");
  return 2;
}
