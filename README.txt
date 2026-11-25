UPDATE 5: repeat, assign, search, drag to reorder, reset list, "what changed"

STEP 1 (app files): upload these 5 files to the ROOT of your GitHub repo
(open this folder, select the 5 .html/.js/.css files, drag them in; NOT the folder).
Do not touch firebase-config.js. Commit.

STEP 2 (one-time, 1 minute): add names support to your Firestore rules.
Firebase console > Firestore Database > Rules. Find the block that looks like

    match /tasks/{id} {
      allow read, write: if allowed();
    }

and paste this RIGHT AFTER it (before the last two closing braces):

    match /members/{id} {
      allow read, write: if allowed();
    }

Click Publish. (Everything works without this step except sharing display names;
the app just falls back to the start of each email.)

STEP 3: fully close and reopen the app on both phones. Each of you will be asked
once, "What should we call you?"
