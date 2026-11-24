/* Tiny portability layer: threads, mutex, condition variable, monotonic clock. */
#ifndef NIIM_PLAT_H
#define NIIM_PLAT_H

#include <stdint.h>

#ifdef _WIN32
#  ifndef WIN32_LEAN_AND_MEAN
#    define WIN32_LEAN_AND_MEAN
#  endif
#  include <windows.h>

typedef HANDLE plat_thread_t;
typedef DWORD plat_thread_id_t;
typedef SRWLOCK plat_mutex_t;
typedef CONDITION_VARIABLE plat_cond_t;
typedef void *(*plat_thread_fn)(void *);

static inline void plat_mutex_init(plat_mutex_t *m) { InitializeSRWLock(m); }
static inline void plat_mutex_destroy(plat_mutex_t *m) { (void)m; }
static inline void plat_mutex_lock(plat_mutex_t *m) { AcquireSRWLockExclusive(m); }
static inline void plat_mutex_unlock(plat_mutex_t *m) { ReleaseSRWLockExclusive(m); }

static inline void plat_cond_init(plat_cond_t *c) { InitializeConditionVariable(c); }
static inline void plat_cond_destroy(plat_cond_t *c) { (void)c; }
static inline void plat_cond_wait(plat_cond_t *c, plat_mutex_t *m) { SleepConditionVariableSRW(c, m, INFINITE, 0); }
/* Wait at most `ms` milliseconds (spurious wakeups possible). */
static inline void plat_cond_timedwait(plat_cond_t *c, plat_mutex_t *m, int64_t ms) {
    SleepConditionVariableSRW(c, m, ms < 0 ? 0 : (DWORD)ms, 0);
}
static inline void plat_cond_broadcast(plat_cond_t *c) { WakeAllConditionVariable(c); }

typedef struct { plat_thread_fn fn; void *arg; } plat__thunk_t;
static DWORD WINAPI plat__thread_main(LPVOID p) {
    plat__thunk_t t = *(plat__thunk_t *)p;
    HeapFree(GetProcessHeap(), 0, p);
    t.fn(t.arg);
    return 0;
}
static inline int plat_thread_create(plat_thread_t *t, plat_thread_fn fn, void *arg) {
    plat__thunk_t *th = (plat__thunk_t *)HeapAlloc(GetProcessHeap(), 0, sizeof(*th));
    if (!th) return -1;
    th->fn = fn;
    th->arg = arg;
    /* 8 MiB stack: QuickJS is configured with a 1 MiB JS stack limit, leave headroom */
    *t = CreateThread(NULL, 8 * 1024 * 1024, plat__thread_main, th, 0, NULL);
    if (*t == NULL) { HeapFree(GetProcessHeap(), 0, th); return -1; }
    return 0;
}
static inline void plat_thread_join(plat_thread_t t) { WaitForSingleObject(t, INFINITE); CloseHandle(t); }
static inline plat_thread_id_t plat_thread_self(void) { return GetCurrentThreadId(); }
static inline int plat_thread_equal(plat_thread_id_t a, plat_thread_id_t b) { return a == b; }

static inline int64_t plat_now_ms(void) { return (int64_t)GetTickCount64(); }

#else /* POSIX */
#  include <pthread.h>
#  include <time.h>
#  include <errno.h>

typedef pthread_t plat_thread_t;
typedef pthread_t plat_thread_id_t;
typedef pthread_mutex_t plat_mutex_t;
typedef pthread_cond_t plat_cond_t;
typedef void *(*plat_thread_fn)(void *);

static inline void plat_mutex_init(plat_mutex_t *m) { pthread_mutex_init(m, NULL); }
static inline void plat_mutex_destroy(plat_mutex_t *m) { pthread_mutex_destroy(m); }
static inline void plat_mutex_lock(plat_mutex_t *m) { pthread_mutex_lock(m); }
static inline void plat_mutex_unlock(plat_mutex_t *m) { pthread_mutex_unlock(m); }

static inline void plat_cond_init(plat_cond_t *c) { pthread_cond_init(c, NULL); }
static inline void plat_cond_destroy(plat_cond_t *c) { pthread_cond_destroy(c); }
static inline void plat_cond_wait(plat_cond_t *c, plat_mutex_t *m) { pthread_cond_wait(c, m); }
static inline void plat_cond_timedwait(plat_cond_t *c, plat_mutex_t *m, int64_t ms) {
    struct timespec ts;
    if (ms < 0) ms = 0;
    clock_gettime(CLOCK_REALTIME, &ts);
    ts.tv_sec += (time_t)(ms / 1000);
    ts.tv_nsec += (long)((ms % 1000) * 1000000L);
    if (ts.tv_nsec >= 1000000000L) { ts.tv_sec += 1; ts.tv_nsec -= 1000000000L; }
    pthread_cond_timedwait(c, m, &ts);
}
static inline void plat_cond_broadcast(plat_cond_t *c) { pthread_cond_broadcast(c); }

static inline int plat_thread_create(plat_thread_t *t, plat_thread_fn fn, void *arg) {
    pthread_attr_t attr;
    int rc;
    pthread_attr_init(&attr);
    pthread_attr_setstacksize(&attr, 8 * 1024 * 1024);
    rc = pthread_create(t, &attr, fn, arg);
    pthread_attr_destroy(&attr);
    return rc == 0 ? 0 : -1;
}
static inline void plat_thread_join(plat_thread_t t) { pthread_join(t, NULL); }
static inline plat_thread_id_t plat_thread_self(void) { return pthread_self(); }
static inline int plat_thread_equal(plat_thread_id_t a, plat_thread_id_t b) { return pthread_equal(a, b); }

static inline int64_t plat_now_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (int64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}
#endif

#endif /* NIIM_PLAT_H */
