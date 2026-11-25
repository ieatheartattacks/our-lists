# Our Lists: setup guide

A shared task app for you and Tyler. It runs as a web page you add to each phone's home screen. Everything below is free and needs no credit card. Plan on about 20 minutes.

Menu names in Firebase's console change now and then, so wording may differ a little from what I describe. The steps stay the same.

## 1. Make a Firebase project

1. Go to https://console.firebase.google.com and sign in with a Google account.
2. Click **Create a project** (or **Add project**). Name it something like `our-lists`.
3. Turn **off** Google Analytics (you don't need it), then create the project.

## 2. Register the web app and copy its settings

1. On the project's home page, click the **web icon** (`</>`).
2. Give it a nickname like `Our Lists`. Do **not** tick Firebase Hosting. Click **Register app**.
3. You will see a block of code containing `const firebaseConfig = { ... }`. Keep this page open.

## 3. Paste the settings into the app

1. Open `firebase-config.js` in a text editor.
2. Replace each `PASTE_HERE` with the matching value from Firebase (apiKey, authDomain, projectId, storageBucket, messagingSenderId, appId). Keep the quotation marks.
3. Save the file.

These values are not passwords. They identify your project. Your lists are protected by the sign-in accounts and the rules in step 5.

## 4. Turn on sign-in and create both accounts

1. In Firebase, go to **Build > Authentication > Get started**.
2. Under **Sign-in method**, choose **Email/Password**, switch on the first toggle (not "Email link"), and save.
3. Open the **Users** tab and click **Add user**. Create one account for your email and one for Tyler's, each with a password. Write down Tyler's password so you can give it to him.
4. If you see **Settings > User actions**, switch off **Enable create (sign-up)**. That stops anyone else from making an account.

## 5. Create the database and lock it to the two of you

1. Go to **Build > Firestore Database > Create database**.
2. Choose the Standard edition, pick a location near you (for example `nam5` or `us-east1`), and start in **production mode**. The location can't be changed later.
3. Open the **Rules** tab.
4. Open `firestore.rules`. Replace `YOUR_EMAIL@example.com` and `TYLER_EMAIL@example.com` with the exact emails you used in step 4. Copy the whole file into the Rules box and click **Publish**.

## 6. Put the app online with GitHub Pages

1. On github.com, create a new **public** repository named `our-lists`.
2. Click **Add file > Upload files**. Drag in everything from this folder: `index.html`, `app.js`, `logic.js`, `style.css`, `sw.js`, `manifest.webmanifest`, `firebase-config.js`, and the `icons` folder. Commit.
3. Go to **Settings > Pages**. Under Source, choose **Deploy from a branch**, branch `main`, folder `/ (root)`. Save.
4. After a minute or two the page shows your address. It will look like `https://YOUR-USERNAME.github.io/our-lists/`.

Because the repository is public, anyone can see your app's code and the Firebase settings in step 3. That's fine. Nobody can read your lists without signing in as one of the two emails.

## 7. Install it on the phones

**Your iPhone:** open the address in **Safari** (it must be Safari). Tap the Share button, then **Add to Home Screen**.

**Tyler's Android:** open the address in Chrome. Tap the menu (three dots), then **Install app** or **Add to Home screen**.

Sign in on each phone with its own email and password. You stay signed in after that.

## 8. Move your lists over

Create your lists with **+ New list** and add the tasks by hand. Microsoft says it will offer an export before To Do shuts down on June 30, 2027, but there's no importer for this app, so recreating them is the simplest way.

## Using the app

- Tap the circle to check a task off. Tap the task text to rename it.
- Tap the three dots on a task to add a subtask, rename, or delete it. Finishing a task also finishes its subtasks.
- Tap the three dots at the top of a list to rename the list, clear finished tasks, or delete the list.
- Changes show up on the other phone within a second or two. The app also works offline and catches up when you reconnect.

## NFC tags and shortcuts

A link like this adds an item without opening the app first:

`https://YOUR-USERNAME.github.io/our-lists/?add=Milk&list=Grocery`

Put that on an NFC tag as a URL. `list=` must match a list name (capitals don't matter). On iPhone a tag opens Safari rather than the home screen app, and Safari keeps its own sign-in, so sign in once there. If you have only one list, `list=` can be left out.

## Updating the app later

Replace the changed files in your GitHub repository. If you change `app.js`, `logic.js`, `style.css`, or `index.html`, also change `CACHE_VERSION` in `sw.js` (for example `v1` to `v2`) so phones pick up the new version. Close and reopen the app on each phone once or twice.

## If something goes wrong

- **"Almost there" screen:** `firebase-config.js` still has `PASTE_HERE` in it, or the old version is cached. Re-upload it and reopen the app.
- **"Email/password sign-in isn't turned on":** repeat step 4, part 2.
- **"Not allowed" or "this account isn't allowed":** the emails in your rules don't exactly match the sign-in emails. Fix them in the Rules tab and click Publish.
- **Tyler forgot his password:** in Firebase, open Authentication > Users, click the three dots next to his account, and choose Reset password.
- **Cost:** Firebase's free plan is far larger than two people with task lists will ever use.
