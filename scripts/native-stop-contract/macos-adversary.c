/* Local validation helper. Never launched by a Provider or production Host. */
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/event.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
#include <EndpointSecurity/EndpointSecurity.h>

extern char **environ;

static void byte(int fd, char value) {
  if (write(fd, &value, 1) != 1) _exit(91);
}

static void gate(int fd) {
  char value;
  if (read(fd, &value, 1) != 1) _exit(92);
}

static void error_result(const char *stage, int code) {
  printf("{\"event\":\"launch-error\",\"stage\":\"%s\",\"errno\":%d}\n", stage, code);
}

static int private_denied(const char *path) {
  int fd = open(path, O_RDONLY);
  if (fd >= 0) {
    close(fd);
    return 0;
  }
  return errno == EPERM || errno == EACCES;
}

static void leaf(const char *operation, const char *private_file,
                 const char *held_file, const char *gate_file, int ready_fd,
                 int change_group) {
  alarm(8);
  errno = 0;
  int result = 0;
  if (change_group == 1) result = setsid();
  if (change_group == 2) result = setpgid(0, 0);
  int group_errno = errno;
  int held = open(held_file, O_WRONLY | O_CREAT | O_TRUNC, 0600);
  if (held >= 0 && write(held, "before\n", 7) != 7) _exit(94);
  printf("{\"event\":\"leaf-ready\",\"operation\":\"%s\",\"pid\":%d,"
         "\"parentPid\":%d,\"group\":%d,\"session\":%d,\"changeResult\":%d,"
         "\"changeErrno\":%d,\"privateDenied\":%s,\"heldOpen\":%s}\n",
         operation, getpid(), getppid(), getpgrp(), getsid(0), result, group_errno,
         private_denied(private_file) ? "true" : "false", held >= 0 ? "true" : "false");

  /* This FIFO is independent of the root's stdin, which Node closes on exit. */
  int control = open(gate_file, O_RDONLY);
  byte(ready_fd, 'R');
  close(ready_fd);
  char action;
  if (control >= 0 && read(control, &action, 1) == 1 && action == 'W') {
    int wrote = held >= 0 && write(held, "after-root-exit\n", 16) == 16;
    printf("{\"event\":\"leaf-completed\",\"wroteAfterRootExit\":%s,\"privateDenied\":%s}\n",
           wrote ? "true" : "false", private_denied(private_file) ? "true" : "false");
  }
  if (control >= 0) close(control);
  if (held >= 0) close(held);
  _exit(0);
}

static int descendant(const char *self, const char *mode,
                      const char *private_file, const char *held_file,
                      const char *gate_file) {
  int ready[2];
  if (pipe(ready)) return 90;
  pid_t child;
  int spawned = 0;
  if (!strcmp(mode, "spawn-setsid")) {
    posix_spawnattr_t attributes;
    posix_spawnattr_init(&attributes);
    posix_spawnattr_setflags(&attributes, POSIX_SPAWN_SETSID);
    char ready_arg[32];
    snprintf(ready_arg, sizeof ready_arg, "%d", ready[1]);
    char *args[] = {(char *)self, "leaf-exec", (char *)private_file,
                    (char *)held_file, (char *)gate_file, ready_arg, NULL};
    int rc = posix_spawn(&child, self, NULL, &attributes, args, environ);
    posix_spawnattr_destroy(&attributes);
    if (rc) {
      error_result("posix_spawn_setsid", rc);
      return 0;
    }
    spawned = 1;
  } else {
    child = fork();
    if (child < 0) {
      error_result("fork", errno);
      return 0;
    }
    if (child == 0) {
      close(ready[0]);
      if (!strcmp(mode, "double-fork")) {
        pid_t grand = fork();
        if (grand < 0) {
          error_result("second_fork", errno);
          _exit(1);
        }
        if (grand > 0) _exit(0);
      }
      leaf(mode, private_file, held_file, gate_file, ready[1],
           !strcmp(mode, "setpgid") ? 2 : 1);
    }
  }
  close(ready[1]);
  char value;
  int ready_ok = read(ready[0], &value, 1) == 1;
  close(ready[0]);
  if (!ready_ok) {
    error_result(spawned ? "spawned_leaf_before_ready" : "forked_leaf_before_ready", EPIPE);
    return 0;
  }
  if (!strcmp(mode, "double-fork")) waitpid(child, NULL, 0);
  printf("{\"event\":\"root-exiting\",\"pid\":%d,\"group\":%d,\"session\":%d}\n",
         getpid(), getpgrp(), getsid(0));
  return 0;
}

static int tracked_fork(const char *private_file, const char *held_file,
                        const char *gate_file) {
  int release[2], ready[2];
  if (pipe(release) || pipe(ready)) return 90;
  pid_t root = fork();
  if (root < 0) {
    error_result("observer_root_fork", errno);
    return 0;
  }
  if (root == 0) {
    close(release[1]);
    close(ready[0]);
    gate(release[0]);
    close(release[0]);
    pid_t child = fork();
    if (child < 0) _exit(93);
    if (child == 0) leaf("kqueue-descendant", private_file, held_file, gate_file, ready[1], 1);
    close(ready[1]);
    _exit(0);
  }
  close(release[0]);
  close(ready[1]);
  int queue = kqueue();
  struct kevent change, receipt;
  struct timespec zero = {0, 0};
  EV_SET(&change, root, EVFILT_PROC, EV_ADD | EV_CLEAR | EV_RECEIPT,
         NOTE_TRACK | NOTE_FORK | NOTE_EXIT, 0, NULL);
  int count = kevent(queue, &change, 1, &receipt, 1, &zero);
  int registration_error = count == 1 && (receipt.flags & EV_ERROR) ? (int)receipt.data : errno;
  int fallback_error = -1;
  if (registration_error) {
    EV_SET(&change, root, EVFILT_PROC, EV_ADD | EV_CLEAR | EV_RECEIPT,
           NOTE_FORK | NOTE_EXIT, 0, NULL);
    count = kevent(queue, &change, 1, &receipt, 1, &zero);
    fallback_error = count == 1 && (receipt.flags & EV_ERROR) ? (int)receipt.data : errno;
  }
  byte(release[1], 'G');
  close(release[1]);
  gate(ready[0]);
  close(ready[0]);

  int saw_exit = 0, saw_fork = 0, child_events = 0, track_errors = 0, events = 0;
  long fork_data = -1;
  struct timespec now;
  clock_gettime(CLOCK_MONOTONIC, &now);
  double deadline = now.tv_sec + now.tv_nsec / 1e9 + 2;
  while (!saw_exit) {
    clock_gettime(CLOCK_MONOTONIC, &now);
    double remaining = deadline - now.tv_sec - now.tv_nsec / 1e9;
    if (remaining <= 0) break;
    struct timespec timeout = {(time_t)remaining, (long)((remaining - (time_t)remaining) * 1e9)};
    struct kevent batch[16];
    int n = kevent(queue, NULL, 0, batch, 16, &timeout);
    if (n < 0) break;
    for (int i = 0; i < n; i++) {
      events++;
      if (batch[i].fflags & NOTE_FORK) { saw_fork = 1; fork_data = batch[i].data; }
      if (batch[i].ident != (uintptr_t)root || (batch[i].fflags & NOTE_CHILD)) child_events++;
      if (batch[i].fflags & NOTE_TRACKERR) track_errors++;
      if (batch[i].ident == (uintptr_t)root && (batch[i].fflags & NOTE_EXIT)) saw_exit = 1;
    }
  }
  struct kevent batch[16];
  int n = kevent(queue, NULL, 0, batch, 16, &zero);
  for (int i = 0; i < n; i++) {
    events++;
    if (batch[i].fflags & NOTE_FORK) { saw_fork = 1; fork_data = batch[i].data; }
    if (batch[i].ident != (uintptr_t)root || (batch[i].fflags & NOTE_CHILD)) child_events++;
    if (batch[i].fflags & NOTE_TRACKERR) track_errors++;
  }
  waitpid(root, NULL, 0);
  close(queue);
  printf("{\"event\":\"kqueue-observed\",\"registrationErrno\":%d,\"fallbackRegistrationErrno\":%d,"
         "\"rootForkObserved\":%s,\"forkEventData\":%ld,\"rootExitObserved\":%s,"
         "\"automaticChildEvents\":%d,\"trackErrorEvents\":%d,\"events\":%d}\n",
         registration_error, fallback_error, saw_fork ? "true" : "false", fork_data,
         saw_exit ? "true" : "false", child_events, track_errors, events);
  return 0;
}

int main(int argc, char **argv) {
  setvbuf(stdout, NULL, _IONBF, 0);
  alarm(10);
  if (argc < 2) return 64;
  if (!strcmp(argv[1], "endpoint-security")) {
    es_client_t *client = NULL;
    es_new_client_result_t result = es_new_client(&client, ^(es_client_t *c, const es_message_t *m) {
      (void)c;
      (void)m;
    });
    printf("{\"event\":\"endpoint-security\",\"result\":%d,\"notEntitled\":%s,"
           "\"notPermitted\":%s,\"notPrivileged\":%s}\n", result,
           result == ES_NEW_CLIENT_RESULT_ERR_NOT_ENTITLED ? "true" : "false",
           result == ES_NEW_CLIENT_RESULT_ERR_NOT_PERMITTED ? "true" : "false",
           result == ES_NEW_CLIENT_RESULT_ERR_NOT_PRIVILEGED ? "true" : "false");
    if (result == ES_NEW_CLIENT_RESULT_SUCCESS) es_delete_client(client);
    return 0;
  }
  if (argc < 5) return 64;
  if (!strcmp(argv[1], "leaf-exec")) {
    if (argc < 6) return 64;
    leaf("spawn-setsid", argv[2], argv[3], argv[4], atoi(argv[5]), 0);
  }
  if (!strcmp(argv[1], "kqueue-track")) return tracked_fork(argv[2], argv[3], argv[4]);
  return descendant(argv[0], argv[1], argv[2], argv[3], argv[4]);
}
