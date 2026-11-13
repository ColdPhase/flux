/*
 * TEST ONLY (#1125, #1437; scripts/check_cli_runtime.sh): the wrapper that points the REAL pinned CLIs at the local vendor mock
 * (app/tests/app/support/cli-vendor-mock.ts), as codex.sh and claude.sh did. It is a static program, not a script, so the CLI's
 * sandbox domain (native/sandbox.c `cli`) holds what production holds and nothing more: this one file, the real CLI's own file
 * and that file's loader. No /bin/sh and no directory is executable there. Its name says which CLI it starts:
 *
 *   codex   the real Codex at /opt/flux-cli-mock/codex: the model and ChatGPT backend by `-c` (`openai_base_url`, `chatgpt_base_url`,
 *           after the `exec` subcommand when there is one), sign-in by `--experimental_issuer` with `--device-auth`, token refresh and
 *           revocation by Codex's own override variables.
 *   claude  the real Claude Code at /opt/flux-tools/claude/bin/claude-real (a link the install step makes to the verified binary):
 *           its model host the mock, and the API key the check wrote into the person's CLI home, if any.
 *
 * The supervisor's argv and environment reach the CLI unchanged otherwise.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define MOCK "http://providermock:8095"

static void add_no_proxy(const char *name) {
  const char *now = getenv(name);
  char value[4096];
  snprintf(value, sizeof(value), "%s%sprovidermock", now && *now ? now : "", now && *now ? "," : "");
  setenv(name, value, 1);
}

static int codex(int argc, char **argv) {
  static const char *real = "/opt/flux-cli-mock/codex";
  setenv("CODEX_REFRESH_TOKEN_URL_OVERRIDE", MOCK "/cli/auth/oauth/token", 1);
  setenv("CODEX_REVOKE_TOKEN_URL_OVERRIDE", MOCK "/cli/auth/oauth/revoke", 1);
  int device = 0;
  for (int i = 1; i < argc; i += 1) if (strcmp(argv[i], "--device-auth") == 0) device = 1;
  char **next = calloc((size_t)argc + 8, sizeof(char *));
  if (!next) return 1;
  int n = 0, from = 1;
  next[n++] = (char *)real;
  if (argc > 1 && strcmp(argv[1], "exec") == 0) { next[n++] = "exec"; from = 2; }
  next[n++] = "-c";
  next[n++] = "openai_base_url=\"" MOCK "/cli/openai/v1\"";
  next[n++] = "-c";
  next[n++] = "chatgpt_base_url=\"" MOCK "/cli/chatgpt/backend-api/\"";
  for (int i = from; i < argc; i += 1) next[n++] = argv[i];
  if (device) { next[n++] = "--experimental_issuer"; next[n++] = MOCK "/cli/auth"; }
  next[n] = NULL;
  execv(real, next);
  fprintf(stderr, "wrap: cannot start %s: %s\n", real, strerror(errno));
  return 126;
}

static int claude(int argc, char **argv) {
  static const char *real = "/opt/flux-tools/claude/bin/claude-real";
  (void)argc;
  const char *home = getenv("CLAUDE_CONFIG_DIR");
  char path[4096];
  snprintf(path, sizeof(path), "%s/flux-mock-api-key", home ? home : "/nonexistent");
  int fd = open(path, O_RDONLY | O_CLOEXEC);
  if (fd >= 0) {
    char key[1024];
    ssize_t got = read(fd, key, sizeof(key) - 1);
    close(fd);
    if (got > 0) {
      while (got > 0 && (key[got - 1] == '\n' || key[got - 1] == '\r')) got -= 1;
      key[got] = 0;
      setenv("ANTHROPIC_API_KEY", key, 1);
    }
  }
  setenv("ANTHROPIC_BASE_URL", MOCK "/cli/anthropic", 1);
  argv[0] = (char *)real;
  execv(real, argv);
  fprintf(stderr, "wrap: cannot start %s: %s\n", real, strerror(errno));
  return 126;
}

int main(int argc, char **argv) {
  add_no_proxy("NO_PROXY");
  add_no_proxy("no_proxy");
  const char *name = strrchr(argv[0], '/');
  name = name ? name + 1 : argv[0];
  if (strcmp(name, "codex") == 0) return codex(argc, argv);
  if (strcmp(name, "claude") == 0) return claude(argc, argv);
  fprintf(stderr, "wrap: called as %s, not codex or claude\n", name);
  return 2;
}
