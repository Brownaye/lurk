# Twitch Pocket

An Android app for watching the channels you follow on Twitch: who is live, the stream, and chat. It is the phone
companion to [Twitch Desktop](https://github.com/Brownaye/twitch-desktop) and signs in the same way.

Unofficial. Not affiliated with or endorsed by Twitch.

## What it does

- **Live.** The channels you follow that are live, with thumbnail, title, category, viewers and uptime, then
  everyone who is offline. Favourites come first. Checked every minute while the app is open.
- **Watch with chat.** Tap a stream: the video plays at the top and chat runs underneath. Turn the phone sideways
  and the video fills the screen. "From the start" plays the recording of a live stream from 0:00.
- **Chat.** Reads as you and lets you type when signed in. Shows Twitch emotes plus 7TV, BetterTTV and
  FrankerFaceZ emotes.
- **Continue.** Past broadcasts you stopped partway through, and live streams you watched for a minute or more and
  then left (rejoin them, or catch up from where you left).
- **VODs.** Past broadcasts from every channel you follow, by day, with your progress in each. Filter by channel
  or favourites, or show only what you have not watched.
- **Schedule.** What the channels you follow have planned for the next 7 days.
- **Channels.** Everyone you follow, when they were last live, your favourites, and your watch time for the week.
- **Settings.** Account, the Live list, the player, and clearing your watch history.
- **Sign in with Twitch.** Device code sign-in with a public client ID, so there is no secret in the app. The
  sign-in page opens inside the app, which also logs the player in, so your subscriptions apply.

Not there yet: hearts, the sleep timer, picture-in-picture, schedule reminders, and alerts while the app is
closed.

## Install

Download `twitch-pocket.apk` from the [latest release](../../releases/latest) and open it on the phone, or with
the phone plugged in:

```
adb install -r twitch-pocket.apk
```

Needs Android 11 or newer. The APK is signed with a debug key, so Android asks you to allow installing from an
unknown source, and an update only installs over a copy signed with the same key.

## Build

Needs JDK 17, the Android SDK (platform 35) and Gradle 8.9 or newer. There is no Gradle wrapper in the repo.

```
echo "sdk.dir=/path/to/Android/Sdk" > local.properties
gradle assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

## How it is put together

A plain Java activity with two web views and no other dependencies:

- `app/src/main/java/.../MainActivity.java`: the window. One web view is the app's own pages, the other shows
  `player.twitch.tv` above them and doubles as the browser for Twitch's sign-in page. It also makes the HTTPS
  requests the pages ask for (Twitch and the three emote services only).
- `app/src/main/assets/www/core.js`: storage, sign-in, and the Twitch API calls behind the Live list.
- `app/src/main/assets/www/data.js`: favourites and settings, watch history, past broadcasts and schedules.
- `app/src/main/assets/www/chat.js`: chat over Twitch IRC, and emotes.
- `app/src/main/assets/www/app.js`: the screens.

Your sign-in, favourites and watch history are kept in the app's private storage on the phone. The app talks to Twitch, and to 7TV, BetterTTV and
FrankerFaceZ for emotes. Nothing else.

## Licence

MIT. See [LICENSE](LICENSE).
