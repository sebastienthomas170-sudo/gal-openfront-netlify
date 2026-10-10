GAL OPENFRONT — SYSTÈME V2 (calcul et sauvegarde côté serveur)
===============================================================

COMMENT ÇA MARCHE
- Toutes les 10 minutes, Netlify réveille « scheduled-refresh ».
- Il lance « refresh-background », qui recalcule TOUT (membres, info clan, classements ALL / 30D / 24H)
  en moins de 9 minutes, et sauvegarde le résultat sur le serveur (Netlify Blobs).
  Chaque section est sauvegardée dès qu'elle est prête : le site n'attend jamais la fin du calcul complet.
- « snapshot » est ce que le site lit : il renvoie le dernier résultat sauvegardé, instantanément.
- Le navigateur ne contacte jamais OpenFront. Il relit le serveur toutes les 60 s et quand on appuie sur Actualiser.
- Si un calcul échoue ou est incomplet, les anciens résultats complets sont conservés (indiqué sous le classement).
- Filet de sécurité : si les données ont plus de 25 min (planificateur arrêté), le site relance lui-même le calcul.

DÉPLOIEMENT (dossier du projet, pas le seul index.html)
1. Installe Node.js LTS : https://nodejs.org/
2. Décompresse le ZIP, ouvre le dossier dans un terminal.
3. Exécute :
     npm install
     npx netlify login
     npx netlify link        (choisis le site GAL EXISTANT)
     npx netlify deploy --prod
4. Ouvre ton site. Au tout premier chargement, le serveur lance le premier calcul tout seul
   (affichage « Le serveur prépare les données… », compte quelques minutes).

VÉRIFIER QUE TOUT MARCHE
- Ouvre https://TON-SITE/.netlify/functions/snapshot
    ready:true  → les données sont prêtes ;
    ready:false → regarde le champ "status" (running = calcul en cours, error = message de l'erreur).
- Netlify → Logs → Functions → refresh-background : chaque étape est journalisée
  ([GAL] étape all terminée…, nombre de requêtes, nombre de 429 d'OpenFront, étapes en échec).
- Netlify → Logs → Functions → scheduled-refresh doit apparaître toutes les 10 minutes
  (les fonctions planifiées ne tournent que sur le déploiement de production publié).

LIMITES
- Les formules et les adresses de l'API OpenFront sont celles de ton index d'origine.
- Si OpenFront renvoie beaucoup d'erreurs 429, une section peut rester « partielle » :
  les résultats complets précédents sont alors conservés et le calcul réessaie au cycle suivant.
