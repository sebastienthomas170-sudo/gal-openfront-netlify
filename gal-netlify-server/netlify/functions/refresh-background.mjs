import { OpenFrontClient, refreshAll } from "../lib/gal.mjs";
import { blobs, storageFor } from "../lib/storage.mjs";

// Fonction « background » (suffixe -background) : Netlify répond 202 aussitôt et la laisse tourner jusqu'à 15 min.
// Le calcul complet est prévu pour durer moins de 9 minutes afin que chaque cycle de 10 minutes soit respecté.
const LOCK_MS = 12 * 60 * 1000;      // un verrou plus vieux que ça est considéré comme mort
const MIN_GAP_MS = 4 * 60 * 1000;    // évite deux calculs rapprochés (planificateur + relance de secours)

export default async (request) => {
  const reason = request.headers.get("x-gal-reason") || "inconnu";
  let storage;
  try {
    storage = storageFor(blobs());
  } catch (error) {
    console.error("[GAL] Netlify Blobs indisponible :", error?.stack || error?.message || error);
    return new Response("Stockage indisponible.", { status: 500 });
  }

  const [lock, status] = await Promise.all([
    storage.get("lock").catch(() => null),
    storage.get("status").catch(() => null)
  ]);
  if (lock?.startedAt && Date.now() - Date.parse(lock.startedAt) < LOCK_MS) {
    console.log("[GAL] calcul déjà en cours, demande ignorée (", reason, ")");
    return new Response("Calcul déjà en cours.", { status: 202 });
  }
  if (status?.finishedAt && Date.now() - Date.parse(status.finishedAt) < MIN_GAP_MS) {
    console.log("[GAL] dernier calcul trop récent, demande ignorée (", reason, ")");
    return new Response("Calcul récent.", { status: 202 });
  }

  const token = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  try {
    await storage.set("lock", { token, startedAt });
    await storage.set("status", { ...(status || {}), state: "running", startedAt, previousFinishedAt: status?.finishedAt || null });
  } catch (error) {
    console.error("[GAL] Impossible d'écrire dans Netlify Blobs au démarrage :", error?.stack || error?.message || error);
    return new Response("Stockage indisponible.", { status: 500 });
  }

  console.log("[GAL] ===== début du calcul ===== déclencheur :", reason);
  try {
    const client = new OpenFrontClient({});
    await refreshAll({ client, storage, budgetMs: 8 * 60 * 1000, log: (...args) => console.log(...args) });
    return new Response("Calcul terminé.", { status: 200 });
  } catch (error) {
    console.error("[GAL] ÉCHEC DU CALCUL (anciennes données conservées) :", error?.stack || error?.message || error);
    await storage.set("status", {
      state: "error", startedAt, finishedAt: new Date().toISOString(),
      message: error?.message || "Erreur inconnue"
    }).catch(() => {});
    return new Response("Calcul en échec.", { status: 500 });
  } finally {
    const current = await storage.get("lock").catch(() => null);
    if (current?.token === token) await storage.delete("lock").catch(() => {});
  }
};
