import { getStore } from "@netlify/blobs";

// Le magasin est créé à l'appel (jamais au chargement du module) : le contexte Netlify Blobs
// n'est garanti que pendant l'exécution d'une fonction. "strong" = lecture toujours à jour.
export const blobs = () => getStore({ name: "gal-v2", consistency: "strong" });

export function storageFor(store = blobs()) {
  return {
    get: (key) => store.get(key, { type: "json" }),
    set: (key, value) => store.setJSON(key, value),
    delete: (key) => store.delete(key)
  };
}

export function siteUrl() {
  return "https://clan-gal.netlify.app";
}

// Demande au site de lancer le calcul en arrière-plan (la fonction répond 202 tout de suite).
export async function triggerRefresh(reason) {
  const base = siteUrl();
  if (!base) throw new Error("URL du site Netlify introuvable (variable URL absente).");
  const endpoint = base + "/.netlify/functions/refresh-background";
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "x-gal-reason": reason || "manual" },
    signal: AbortSignal.timeout(10000)
  });
  return { status: response.status, endpoint };
}
