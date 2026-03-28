---
layout: post
title: "Building Real-Time Data Pipelines with Kafka and Spark Structured Streaming"
date: 2026-03-28
categories: [data-engineering, streaming]
tags: [kafka, spark, pyspark, structured-streaming, real-time]
excerpt: "Structured Streaming turns Spark into a first-class stream processor. Here's how to wire it to Kafka correctly — covering offset management, watermarking, stateful aggregations, and the production pitfalls that bite teams at scale."
---

Real-time data pipelines fail in predictable ways. The message bus fills up, a consumer falls behind, stateful joins balloon in memory, and suddenly your "low-latency" pipeline is hours behind. After running Kafka + Spark Structured Streaming in production at scale, here are the patterns that actually hold up.

## Why Structured Streaming over Spark Streaming (DStreams)

The older DStream API operates on RDDs with micro-batches bolted on as an afterthought. Structured Streaming is built on DataFrames end-to-end, which means the Catalyst optimizer understands your query, predicate pushdown works, and you get exactly-once semantics without managing offsets manually.

The mental model shift matters: you write a batch query against an unbounded table. Spark handles the incremental execution.

## Connecting to Kafka

```python
from pyspark.sql import SparkSession
from pyspark.sql.functions import col, from_json, window, count
from pyspark.sql.types import StructType, StructField, StringType, LongType, DoubleType

spark = (
    SparkSession.builder
    .appName("realtime-pipeline")
    .config("spark.sql.shuffle.partitions", "64")
    .config("spark.streaming.stopGracefullyOnShutdown", "true")
    .getOrCreate()
)

raw = (
    spark.readStream
    .format("kafka")
    .option("kafka.bootstrap.servers", "kafka-broker:9092")
    .option("subscribe", "ride_events")
    .option("startingOffsets", "latest")
    .option("maxOffsetsPerTrigger", 500_000)       # back-pressure knob
    .option("kafka.group.id", "spark-pipeline-v1")
    .load()
)
```

`maxOffsetsPerTrigger` is the most important back-pressure lever. Without it, a catching-up consumer will pull millions of records into a single micro-batch and OOM. Set it conservatively first, then tune upward with profiling data.

## Deserialising and Typing the Payload

Kafka gives you raw bytes. Define your schema explicitly — never infer it from data in production.

```python
event_schema = StructType([
    StructField("event_id",    StringType(),  False),
    StructField("user_id",     StringType(),  False),
    StructField("event_type",  StringType(),  True),
    StructField("amount",      DoubleType(),  True),
    StructField("ts",          LongType(),    False),   # epoch ms
])

from pyspark.sql.functions import from_json, from_unixtime, col

events = (
    raw
    .selectExpr("CAST(value AS STRING) AS json_str", "timestamp AS kafka_ts")
    .select(
        from_json(col("json_str"), event_schema).alias("e"),
        col("kafka_ts")
    )
    .select("e.*", "kafka_ts")
    .withColumn("event_time", (col("ts") / 1000).cast("timestamp"))
)
```

Separate processing time (`kafka_ts`) from event time (`event_time`). Aggregations should almost always use event time — processing time makes your metrics wrong whenever a producer burps.

## Watermarking and Late Data

Without a watermark, Spark accumulates state for every event-time window forever. With one, it knows it can safely evict state for windows older than `now - watermark_delay`.

```python
windowed_counts = (
    events
    .withWatermark("event_time", "10 minutes")        # tolerate up to 10 min late arrivals
    .groupBy(
        window(col("event_time"), "1 minute", "30 seconds"),  # 1-min tumbling, 30-sec slide
        col("event_type")
    )
    .agg(
        count("*").alias("event_count"),
    )
)
```

The watermark delay is a business decision disguised as a tuning parameter. Set it too tight and you drop legitimate late events. Too loose and your state store grows unboundedly. Profile your producer lag distribution (p99, not p50) and set the watermark at roughly p99 + buffer.

## Writing to the Sink

For Kafka output:

```python
query = (
    windowed_counts
    .selectExpr(
        "CAST(event_type AS STRING) AS key",
        "to_json(struct(*)) AS value"
    )
    .writeStream
    .format("kafka")
    .option("kafka.bootstrap.servers", "kafka-broker:9092")
    .option("topic", "ride_event_counts")
    .option("checkpointLocation", "s3://your-bucket/checkpoints/ride-counts/")
    .outputMode("update")          # emit updated windows as they change
    .trigger(processingTime="30 seconds")
    .start()
)

query.awaitTermination()
```

The checkpoint location is not optional — it is where Spark stores offsets and operator state. Lose it and you lose exactly-once guarantees and must replay from the beginning. Put it on durable storage (S3, GCS, HDFS), not local disk.

## Output Modes: A Common Source of Confusion

- **`append`** — only emit rows that will never change (requires watermark on aggregations)
- **`update`** — emit rows whenever they change; works for most aggregations
- **`complete`** — re-emit the entire result table every trigger; only viable for small result sets

For windowed aggregations writing to a downstream Kafka topic or database, `update` is almost always the right choice.

## Production Checklist

A few things that catch teams off-guard:

**State store tuning.** Stateful ops (joins, aggregations) use RocksDB by default in newer Spark versions. Tune `spark.sql.streaming.stateStore.rocksdb.changelogCheckpointing.enabled` and monitor state store metrics in the Spark UI.

**Schema evolution.** When your Kafka producer adds a field, `from_json` silently returns `null` for unknown fields. Version your schemas with a schema registry (Confluent or AWS Glue) and validate at deserialization time rather than discovering nulls downstream.

**Graceful shutdown.** `spark.streaming.stopGracefullyOnShutdown=true` lets the current micro-batch finish before stopping. Without it, a SIGTERM during a write can leave partial output and force an expensive offset replay.

**Partition alignment.** Kafka partitions map to Spark tasks. If your topic has 12 partitions and you set `spark.sql.shuffle.partitions=200`, you are creating 200 shuffle tasks for 12 input partitions. Match shuffle partitions to your downstream data volume, not to the Kafka partition count.

---

Real-time pipelines reward explicit design decisions. Every default you accept is a latency, memory, or correctness assumption that will eventually surface in a 2am page. Audit the knobs, watermark your event time, and keep your checkpoint location on durable storage.
