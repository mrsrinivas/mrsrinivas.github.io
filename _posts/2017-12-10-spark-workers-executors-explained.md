---
title: "Spark Workers, Executors, and the Cluster Runtime — A Visual Guide"
date: 2017-12-10 10:00:00 +0800
categories: [Data Engineering, Spark]
tags: [spark, distributed-systems, cluster-computing, yarn]
mermaid: true
---

Three terms — worker, worker instance, and executor — appear constantly in Spark documentation, conference talks, and configuration files. They are easy to conflate because they all refer to components that run on cluster machines. They are not the same thing, and understanding the distinction matters when sizing clusters, tuning memory, and diagnosing slow jobs.

## The Spark Standalone cluster

In Spark Standalone mode there are two roles: a **Master** and one or more **Workers**. The Master is the cluster manager — it tracks available resources and assigns them to applications. Workers are the resource providers — they report their CPU and memory to the Master and spawn Executors when asked.

```mermaid
graph TB
    D["Driver Program\n(SparkContext / DAGScheduler / TaskScheduler)"]

    M["Master Node\n(Cluster Manager — assigns resources to apps)"]

    subgraph W1["Worker Node 1"]
        E1["Executor JVM 1\n● Task  ● Task  ○ idle"]
        E2["Executor JVM 2\n● Task  ● Task  ● Task"]
    end
    subgraph W2["Worker Node 2"]
        E3["Executor JVM 1\n● Task  ● Task  ● Task"]
        E4["Executor JVM 2\n● Task  ● Task  ● Task"]
    end
    subgraph W3["Worker Node 3"]
        E5["Executor JVM 1\n● Task  ● Task  ● Task"]
        E6["Executor JVM 2\n● Task  ● Task  ● Task"]
    end

    D -->|"submits app"| M
    M --> W1 & W2 & W3
```

A few things worth noting in this picture:

- The **Driver** (your SparkContext) talks to the Master, not directly to Workers
- The Master assigns resources and tells Workers which Executors to launch
- Each Worker Node runs one or more **Executor JVM processes**, depending on available CPU and memory
- Executors hold data in memory and run tasks — they are the actual compute units

## 1 Node = 1 Worker process

A common source of confusion: "worker instance" does not mean an instance of your application. It means a **worker process** — a daemon that runs on a machine, registers with the Master, and manages that machine's contribution to the cluster.

The recommended mapping is:

```
1 Physical / Virtual Machine = 1 Worker process
```

You can run multiple worker processes on a single machine, but there is rarely a reason to do so. It adds coordination overhead without adding resources that aren't already available.

## How many executors can a worker hold?

This is the more interesting question. A Worker process can spawn **multiple Executor processes** — each one is a separate JVM — as long as the machine has sufficient CPU cores, memory, and storage.

```mermaid
graph TB
    subgraph Machine["Physical / Virtual Machine"]
        WP["Worker Process\n(1 per node — manages resources, spawns executors)"]

        subgraph E1["Executor JVM 1  |  Heap: 4 GB  |  Cores: 3"]
            T1A["● Task (running)"]
            T1B["● Task (running)"]
            T1C["○ (idle)"]
        end
        subgraph E2["Executor JVM 2  |  Heap: 4 GB  |  Cores: 3"]
            T2A["● Task (running)"]
            T2B["○ (idle)"]
            T2C["○ (idle)"]
        end
        subgraph E3["Executor JVM 3  (not started yet)"]
            E3N["spawned when workload demands\nand resources allow"]
        end

        WP --> E1 & E2 & E3
    end
```

The number of executors running on a worker node at any point in time depends on two things:

1. **The cluster workload** — how many applications are running and how many executors they requested
2. **The node's capacity** — how many CPU cores and how much memory remain unallocated

Each Executor is a separate JVM process with its own heap. It holds RDD partitions in memory (for caching) and runs tasks in its thread pool. Executors live for the duration of the application — they are not created and destroyed per task.

### Worker vs Executor — the key difference

| | Worker | Executor |
|---|---|---|
| **What it is** | A long-lived daemon process on a node | A JVM process launched per application |
| **Lifetime** | Runs as long as the cluster is up | Runs for the duration of one application |
| **Scope** | Manages node resources | Runs tasks, caches data |
| **Count** | 1 per node (recommended) | N per worker (based on resources) |

## How Spark executes a program

Given a program that joins two RDDs, reduces, then filters:

```scala
val result = rdd1
  .join(rdd2)    // shuffle — data must move across the network
  .reduce(...)   // aggregation per partition
  .filter(...)   // narrow transformation — no shuffle
```

Spark's execution model turns this into a **DAG of RDD operations**, splits the DAG into **Stages** at shuffle boundaries, and breaks each stage into **Tasks** — one per RDD partition — that run in parallel on Executors.

```mermaid
flowchart TB
    Code["Spark Application Code\nrdd1.join(rdd2).reduce(...).filter(...)"]

    subgraph Driver["Driver / SparkContext"]
        DAG["DAGScheduler — builds DAG, splits into stages"]
        TSched["TaskScheduler — assigns tasks to executor slots"]
        DAG --> TSched
    end

    subgraph Stages["Stages (sequential)"]
        S1["Stage 1: rdd1.join(rdd2)\n🔀 shuffle boundary — data redistribution"]
        S2["Stage 2: .reduce(...)\naggregation per partition"]
        S3["Stage 3: .filter(...)\nnarrow transform, no shuffle needed"]
        S1 --> S2 --> S3
    end

    subgraph Executors["Executors (parallel task execution)"]
        EA["Executor A — Worker 1\nTask P0 | Task P1 | Task P2"]
        EB["Executor B — Worker 2\nTask P3 | Task P4 | Task P5"]
        EC["Executor C — Worker 3\nTask P6 | Task P7 | ○ idle"]
    end

    R["Results collected → Driver"]

    Code --> Driver
    Driver --> Stages
    Stages --> Executors
    Executors --> R
```

Walking through the diagram:

**Driver** receives the code, builds the DAG, and identifies shuffle boundaries. Each boundary becomes a stage split.

**Stage 1 — join**: Spark must redistribute data across the network (shuffle) so that matching keys from `rdd1` and `rdd2` land on the same partition. This is the most expensive stage.

**Stage 2 — reduce**: After the shuffle, aggregation happens locally per partition. No data movement.

**Stage 3 — filter**: A narrow transformation — each partition is filtered independently. Spark can pipeline this with Stage 2 within the same executor without an additional shuffle.

**Tasks**: Each stage is split into tasks equal to the number of partitions. Tasks within a stage run in parallel across all available Executor slots. Stages run in sequence (the output of Stage 1 is the input to Stage 2).

**Results** flow back to the Driver once all tasks in the final stage complete.

## Spark on YARN

On YARN, the roles map directly:

| Standalone | YARN |
|---|---|
| Master | ResourceManager |
| Worker | NodeManager |
| Executor | Container (running the Executor JVM) |

The conceptual model is identical — one resource manager, N node agents, M executor processes per node based on capacity. YARN adds the ApplicationMaster (runs inside a container, takes over the scheduling role of the Driver in cluster deploy mode).

## Summary

- **Worker** = a process running on a cluster node, registered with the Master, responsible for spawning Executors
- **1 Node → 1 Worker** is the standard mapping; multiple workers per node is possible but uncommon
- **Executor** = a JVM process launched by the Worker for a specific application; holds cached RDD data and runs tasks; multiple per Worker if resources allow
- **Task** = the unit of work within a stage; one per RDD partition; runs inside an Executor thread
- **Stage** = a set of tasks with no shuffle between them; stages are separated by shuffle boundaries
- **DAG Scheduler** converts your code into stages; **Task Scheduler** assigns tasks to Executor slots
