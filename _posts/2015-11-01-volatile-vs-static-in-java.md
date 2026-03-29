---
title: "volatile vs static in Java — Thread Visibility Explained"
date: 2015-11-01 10:00:00 +0800
categories: [Software Engineering, Java]
tags: [java, concurrency, multithreading, jvm]
mermaid: true
---

`static` and `volatile` both deal with shared data, but they solve completely different problems. Conflating them is one of the most common sources of subtle multithreading bugs in Java. This post explains exactly what each does, why the difference matters, and when to use each.

## The Java Memory Model

Modern CPUs do not read from RAM on every variable access — they maintain L1 and L2 caches per core to avoid the latency cost. The JVM is allowed to exploit this: it may keep a variable's value in a CPU register or cache instead of reading it from main memory on every access.

This is a deliberate performance optimisation. It also means that two threads running on different CPU cores can hold **different values for the same variable** at the same time.

```mermaid
graph TB
    subgraph MM["Main Memory (Heap)"]
        MV["static int counter = 0\nvolatile boolean flag = false\n— volatile is always read/written here, never cached —"]
    end
    subgraph Core1["CPU Core 1"]
        C1["L1/L2 Cache\ncounter = 5\n(local copy, may differ from main memory)"]
        T1["Thread 1\ncounter++\n// reads cache: 5 → cache now: 6"]
        C1 --> T1
    end
    subgraph Core2["CPU Core 2"]
        C2["L1/L2 Cache\ncounter = 0\n(stale — unaware of Thread 1 update)"]
        T2["Thread 2\nprint(counter)\n// reads cache → prints 0, expects 5!"]
        C2 --> T2
    end
    MM <-->|"write-back (may delay)"| C1
    MM <-->|"read (may be stale)"| C2
```

This is the Java Memory Model (JMM) in one picture. Main memory holds the authoritative value. Each CPU core has its own cache. Threads read from and write to their core's cache, not necessarily to main memory.

## `static` — one instance, but threads can still cache it

`static` is a **scope modifier**. A `static` variable belongs to the class, not to any instance. There is exactly one copy in the JVM, shared across all instances of that class.

```java
class Counter {
    static int count = 0;  // one copy, shared by all instances
}
```

What `static` does **not** do: it gives no guarantee about memory visibility across threads. The JVM may cache a `static` variable in a CPU register for performance. Thread 1 can update the value and Thread 2 may never see it, because Thread 2 is reading from its own core's cache.

```mermaid
graph TB
    subgraph MM["Main Memory"]
        MV["static int counter = 0"]
    end
    subgraph T1Box["Thread 1 Cache (CPU Core 1)"]
        C1["counter = 5\n(updated locally, not flushed)"]
    end
    subgraph T2Box["Thread 2 Cache (CPU Core 2)"]
        C2["counter = 0\n(stale — never saw update)"]
    end
    R["Thread 2 reads: if (counter == 5) ...\n→ reads 0 — condition false! ❌  STALE READ"]

    MM -->|"initial load"| C1
    MM -->|"initial load"| C2
    C2 --> R

    style C2 fill:#fca5a5,color:#7f1d1d
    style R fill:#fca5a5,color:#7f1d1d
```

Thread 1 increments `counter` to 5. Thread 2 reads `counter` and gets 0. Thread 1's update never left its CPU cache, so Thread 2 has no way to observe it. Both threads are using the same `static` variable — they just each have a stale copy.

## `volatile` — forces main memory visibility

`volatile` is a **memory visibility modifier**. It instructs the JVM to never cache this variable. Every read goes directly to main memory. Every write is immediately flushed to main memory.

```java
class Server {
    volatile boolean running = true;  // never cached, always from main memory

    void shutdown() {
        running = false;  // written directly to main memory
    }

    void run() {
        while (running) {  // read directly from main memory on each iteration
            // process work
        }
    }
}
```

```mermaid
graph TB
    subgraph MM["Main Memory"]
        MV["volatile boolean flag = true\n(single authoritative source)"]
    end
    subgraph T1Box["Thread 1"]
        T1["flag = true\n(writes directly to main memory\nno local cache for volatile)"]
    end
    subgraph T2Box["Thread 2"]
        T2["if (flag) { ... }\n(reads directly from main memory\nalways sees latest value)"]
        R["flag = true — condition holds! ✓  VISIBLE"]
        T2 --> R
    end

    T1 -->|"write directly to main memory"| MM
    MM -->|"read directly from main memory"| T2

    style R fill:#bbf7d0,color:#14532d
    style T1Box fill:#dcfce7
    style T2Box fill:#dbeafe
```

Thread 1 sets `flag = true`. Because `flag` is `volatile`, this write goes directly to main memory. Thread 2 reads `flag` directly from main memory on every access. It immediately sees the update.

`volatile` also establishes a **happens-before relationship**: anything Thread 1 did before writing to a `volatile` variable is guaranteed to be visible to Thread 2 after it reads that `volatile` variable.

## `static volatile` — use both together

`static` and `volatile` are orthogonal. `static` controls scope (class-level), `volatile` controls memory visibility. You can and often should combine them:

```java
class AppConfig {
    private static volatile boolean debugMode = false;  // class-level + always visible

    public static void enableDebug() {
        debugMode = true;
    }

    public static boolean isDebugEnabled() {
        return debugMode;
    }
}
```

This is the correct pattern for a shared flag accessible across threads without creating an instance. `static` makes it class-level. `volatile` ensures every thread always reads the current value.

The difference in plain terms:

| | `static` | `volatile` |
|---|---|---|
| **What it does** | One instance per class | No CPU caching |
| **Scope** | Class-level | N/A |
| **Thread visibility** | Not guaranteed | Guaranteed |
| **Atomicity** | No | No |
| **Can combine** | Yes | Yes |

## `volatile` does not mean atomic

This is the most important limitation. `volatile` guarantees **visibility** but not **atomicity**. The classic trap is using `volatile` on a counter:

```java
volatile int counter = 0;
counter++;  // looks atomic, is NOT
```

`counter++` compiles to three operations:

1. **READ** — load the current value from main memory
2. **INCREMENT** — add 1 to the local copy
3. **WRITE** — store the result back to main memory

Two threads can interleave these three operations and produce the wrong result:

```mermaid
sequenceDiagram
    participant T1 as Thread 1
    participant MM as Main Memory
    participant T2 as Thread 2

    Note over MM: counter = 0

    rect rgb(219,234,254)
        Note over T1,T2: Step 1 — READ
        T1->>MM: reads counter = 0
        T2->>MM: reads counter = 0
    end
    rect rgb(254,249,195)
        Note over T1,T2: Step 2 — INCREMENT (local)
        Note over T1: 0 + 1 = 1
        Note over MM: counter = 0 (unchanged)
        Note over T2: 0 + 1 = 1
    end
    rect rgb(254,226,226)
        Note over T1,T2: Step 3 — WRITE
        T1->>MM: writes counter = 1
        T2->>MM: writes counter = 1 (overwrites!)
    end

    Note over MM: RESULT: counter = 1 ❌ (expected 2)
    Note over T1,T2: Both incremented from 0 — one update lost
```

Both threads read `counter = 0`, both increment to 1, both write 1. The expected result is 2. You get 1. `volatile` prevented caching — both threads correctly saw `counter = 0` — but that only made the race condition more deterministic. It did not prevent it.

For atomic operations, use `java.util.concurrent.atomic`:

```java
AtomicInteger counter = new AtomicInteger(0);
counter.incrementAndGet();  // atomic read-modify-write, thread-safe
```

## When to use what

| Scenario | Correct tool |
|---|---|
| Shared on/off flag between threads | `static volatile boolean` |
| Shared singleton reference | `volatile` with double-checked locking |
| Thread-safe counter | `AtomicInteger` |
| Thread-safe compound operation | `synchronized` or `ReentrantLock` |
| Thread-local state | `ThreadLocal<T>` |
| Immutable shared state | `final` + safe publication |

A good rule of thumb: if a variable is **written by one thread and read by others**, `volatile` is sufficient. If it is **read and written by multiple threads** (like a counter), you need atomics or synchronization.

## Summary

- **`static`** = one instance for all threads to share. Does not prevent per-CPU caching.
- **`volatile`** = no caching, every read and write goes through main memory. Guarantees visibility, not atomicity.
- **`static volatile`** = combine them freely. Class-level scope with full visibility guarantee.
- **`volatile` + `++`** = still a race condition. Use `AtomicInteger` for thread-safe mutation.

