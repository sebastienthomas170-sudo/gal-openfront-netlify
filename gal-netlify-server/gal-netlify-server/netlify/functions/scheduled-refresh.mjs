import { triggerRefresh } from "../lib/storage.mjs";

// Toutes les 10 minutes : réveille la fonction de calcul (qui, elle, peut durer jusqu'à 15 min).
export default async () => {
  try {
    const result = await triggerRefresh("planificateur");
    console.log("[GAL planificateur] calcul demandé — HTTP", result.status, result.endpoint);
  } catch (error) {
    console.error("[GAL planificateur] ÉCHEC du déclenchement :", error?.stack || error?.message || error);
  }
};

export const config = { schedule: "*/10 * * * *" };
