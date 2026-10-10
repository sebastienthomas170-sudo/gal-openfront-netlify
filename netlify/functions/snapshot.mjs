import { blobs, storageFor, triggerRefresh } from "../lib/storage.mjs";

const STALE_MS = 25 * 60 * 1000; // si les données ont plus de 25 min, le site relance lui-même le calcul

const json = (body) => new Response(JSON.stringify(body), {
  status: 200,
  headers: {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store, max-age=0",
    "Access-Control-Allow-Origin": "*"
  }
});

export default async (request, context) => {
  let data = null;
  let status = null;
  try {
    const storage = storageFor(blobs());
    [data, status] = await Promise.all([
      storage.get("data").catch((error) => { console.error("[GAL snapshot] lecture data :", error?.message || error); return null; }),
      storage.get("status").catch(() => null)
    ]);
  } catch (error) {
    console.error("[GAL snapshot] Netlify Blobs indisponible :", error?.stack || error?.message || error);
    return json({ ready: false, status: { state: "error", message: "Stockage du serveur indisponible." }, serverTime: new Date().toISOString() });
  }

  const age = data?.generatedAt ? Date.now() - Date.parse(data.generatedAt) : Infinity;
  const running = status?.state === "running" && status.startedAt && Date.now() - Date.parse(status.startedAt) < 12 * 60 * 1000;
  if (age > STALE_MS && !running) {
    // Filet de sécurité si le planificateur ne tourne pas : on relance le calcul sans faire attendre le visiteur.
    const job = triggerRefresh("relance par le site").then(
      (result) => console.log("[GAL snapshot] données périmées, calcul relancé — HTTP", result.status),
      (error) => console.error("[GAL snapshot] relance impossible :", error?.message || error)
    );
    if (typeof context?.waitUntil === "function") context.waitUntil(job);
  }

  const ready = !!(data && Array.isArray(data.members) && data.members.length);
  if (!ready) return json({ ready: false, status, serverTime: new Date().toISOString() });
  return json({ ready: true, ...data, status, serverTime: new Date().toISOString() });
};
