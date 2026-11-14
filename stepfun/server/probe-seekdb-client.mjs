// Probe: which seekdb instances are reachable, and what schema/upsert shapes work.
import { SeekdbClient, Schema, FulltextIndexConfig, VectorIndexConfig } from "seekdb";

const targets = [
  { label: "docker-2881", host: "127.0.0.1", port: 2881, password: "difyai123456" },
  { label: "wsl-2882", host: "127.0.0.1", port: 2882, password: "" },
];

for (const target of targets) {
  console.log(`\n=== ${target.label} ===`);
  let client;
  try {
    client = new SeekdbClient({
      host: target.host,
      port: target.port,
      user: "root",
      password: target.password,
      database: "test",
    });
    await client.getOrCreateCollection({
      name: "probe_fulltext_only",
      schema: new Schema().createIndex(new FulltextIndexConfig()),
      embeddingFunction: null,
    });
    const col = await client.getOrCreateCollection({
      name: "probe_fulltext_only",
      schema: new Schema().createIndex(new FulltextIndexConfig()),
      embeddingFunction: null,
    });
    console.log("fulltext-only collection ok:", col?.name ?? col?.id);
    await col.upsert({
      ids: ["probe-1"],
      documents: ["燭火廳的銅鑰匙藏在吧台下"],
      metadatas: [{ session_id: "s1", op: "write" }],
    });
    const got = await col.get({ ids: ["probe-1"], include: ["documents", "metadatas"] });
    console.log("fulltext-only upsert+get:", JSON.stringify(got).slice(0, 300));
    const q = await col.query({ whereDocument: { $contains: "燭火" }, nResults: 5, include: ["documents"] });
    console.log("fulltext-only query:", JSON.stringify(q).slice(0, 300));
  } catch (error) {
    console.log("ERR:", error.message.split("\n")[0]);
  } finally {
    try {
      if (client?.close) await client.close();
    } catch {}
  }
}
