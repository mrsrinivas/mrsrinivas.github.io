---
title: "Kafka Topics and Partitions — How I Think About Them"
date: 2018-08-13 19:16:00 +0800
categories: [Data Engineering, Messaging]
tags: [kafka, distributed-systems, streaming, consumer-groups]
---

When I first started working with Kafka, the producer/consumer mental model felt intuitive until partitions entered the picture. Questions like *"who decides which partition a message lands in?"* or *"how does a consumer group actually divide work?"* were things I had to think through carefully. This post is how I now explain it to myself — and to teammates.

## The Producer Side: Who Picks the Partition?

A producer always targets a **topic**, not a partition directly. But under the hood, every message ends up in exactly one partition. The decision follows a simple priority chain:

1. **Explicit partition id** — if you set it in the message, it goes there, full stop.
2. **Key-based hashing** — if you supply a message key, Kafka computes `key % num_partitions` and routes consistently. Same key always hits the same partition. This is what gives you ordering guarantees per entity (e.g. all events for `user_id=42` land in the same partition, in order).
3. **Round-robin** — no partition, no key? Messages are distributed evenly across partitions. Good for throughput, no ordering guarantees.

The key insight: **ordering is only guaranteed within a partition**. If you need global ordering, you're stuck with one partition — which kills parallelism. Most real systems trade ordering scope for throughput by choosing keys carefully.

## The Consumer Side: Group ID Matters More Than You Think

Every consumer should set a `group.id`. Without it, you're using the simple assignment API — you handle partition assignment yourself and Kafka won't track your offsets.

With a group ID, Kafka treats all consumers sharing that ID as a **single logical subscriber**. The group collectively consumes the topic, with each partition assigned to exactly one consumer in the group at a time.

## Partition-to-Consumer Mapping: Three Scenarios

This is where it clicked for me. Think of partitions as units of work and consumers as workers.

**Fewer consumers than partitions** — some consumers handle multiple partitions. Still works, just means some workers are busier.

![Fewer consumers than partitions](https://i.sstatic.net/zq0Mz.png)

**Consumers equal partitions** — clean 1:1 mapping. Each consumer owns exactly one partition. This is the ideal steady state.

![Equal consumers and partitions](https://i.sstatic.net/qw3MC.png)

**More consumers than partitions** — the extra consumers sit idle. Kafka can't split a partition across consumers within a group. So if you have 5 consumers and 4 partitions, Consumer 5 does nothing. Scaling beyond partition count gives you zero benefit.

![More consumers than partitions](https://i.sstatic.net/jXcjI.png)

This last scenario is a common mistake when teams try to "scale out" consumers without increasing partition count first. **Add partitions before adding consumers.**

## Who Manages Offsets?

Kafka tracks where each consumer group is up to via the internal `__consumer_offsets` topic. By default `enable.auto.commit=true` and Kafka handles this for you.

When you need more control — say, you only want to commit after successfully writing to a downstream system — set `enable.auto.commit=false` and call `consumer.commitSync()` or `consumer.commitAsync()` yourself.

The entity coordinating all of this is the **Group Coordinator**, an elected broker in the cluster that:
- Receives periodic heartbeats from consumers
- Handles offset commits and fetch requests
- Triggers rebalances when consumers join or leave the group

## What Happens When Messages Expire?

Retention is a topic-level setting (default 7 days). When messages age out, the offsets that pointed to them become meaningless. If a consumer starts fresh after all messages have expired, the `auto.offset.reset` config decides what to do:

- `latest` — start from new messages arriving now (default behaviour, sensible for most cases)
- `earliest` — start from the oldest available message

There's no way to "go back" past what's been retained. Design your retention window around your slowest possible consumer, not your average one.

---

This mental model has served me well across many Kafka deployments. The partition is the fundamental unit of parallelism — everything else (producer routing, consumer scaling, offset tracking) flows from understanding that.

*Originally shared as an [answer on Stack Overflow](https://stackoverflow.com/a/52009243/1592191), expanded here.*
