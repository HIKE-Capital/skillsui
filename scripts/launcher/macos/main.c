#include <limits.h>
#include <mach-o/dyld.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

/*
 * Skillsui.app launcher. Resolves the bundle's Resources directory, points the
 * server at the bundled engine and web assets, then replaces this process with
 * the bundled Node runtime. Keeping the launcher as a real Mach-O executable
 * means Finder/Dock show the app icon instead of a generic script icon.
 */
int main(void) {
  char executable[PATH_MAX];
  uint32_t size = sizeof(executable);
  if (_NSGetExecutablePath(executable, &size) != 0) {
    return 1;
  }

  char resolved[PATH_MAX];
  if (realpath(executable, resolved) == NULL) {
    return 1;
  }

  char *slash = strrchr(resolved, '/');
  if (slash == NULL) {
    return 1;
  }
  *slash = '\0';

  char resources[PATH_MAX];
  snprintf(resources, sizeof(resources), "%s/../Resources", resolved);

  char resourcesReal[PATH_MAX];
  if (realpath(resources, resourcesReal) == NULL) {
    return 1;
  }

  char node[PATH_MAX];
  char server[PATH_MAX];
  char engine[PATH_MAX];
  char web[PATH_MAX];
  snprintf(node, sizeof(node), "%s/node", resourcesReal);
  snprintf(server, sizeof(server), "%s/app/server.mjs", resourcesReal);
  snprintf(engine, sizeof(engine), "%s/engine", resourcesReal);
  snprintf(web, sizeof(web), "%s/app/web", resourcesReal);

  setenv("SKILLSUI_ENGINE_DIR", engine, 1);
  setenv("SKILLSUI_WEB_DIR", web, 1);

  execl(node, node, server, (char *)NULL);
  return 1;
}
