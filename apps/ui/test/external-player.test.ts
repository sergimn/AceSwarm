import { describe, expect, it } from "vitest";
import {
  absoluteUrl,
  androidIntentUrl,
  handOffFor,
  handOffMessage,
  isAndroid,
  m3uFileName,
  m3uPlaylist,
} from "../src/external-player.ts";

const PLAYLIST = "http://192.0.2.10:8080/hls/s1/external/index.m3u8";

const CHROME_ON_LINUX =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const CHROME_ON_ANDROID_TV =
  "Mozilla/5.0 (Linux; Android 12; BRAVIA 4K VH2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const FIREFOX_ON_ANDROID = "Mozilla/5.0 (Android 14; Mobile; rv:140.0) Gecko/140.0 Firefox/140.0";

describe("absoluteUrl", () => {
  it("puts the page's scheme, host and port before the playlist's path", () => {
    expect(absoluteUrl("/hls/s1/external/index.m3u8", "http://192.0.2.10:8080/")).toBe(PLAYLIST);
    expect(absoluteUrl("/hls/s1/external/index.m3u8", "https://tv.example/some/page?x=1#top")).toBe(
      "https://tv.example/hls/s1/external/index.m3u8",
    );
  });
});

describe("isAndroid", () => {
  it("tells Android browsers, TVs included, from the others", () => {
    expect(isAndroid(CHROME_ON_ANDROID_TV)).toBe(true);
    expect(isAndroid(FIREFOX_ON_ANDROID)).toBe(true);
    expect(isAndroid(CHROME_ON_LINUX)).toBe(false);
    expect(isAndroid("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15")).toBe(
      false,
    );
  });
});

describe("androidIntentUrl", () => {
  it("asks Android to view the playlist as an HLS stream, in no app in particular", () => {
    expect(androidIntentUrl(PLAYLIST)).toBe(
      "intent://192.0.2.10:8080/hls/s1/external/index.m3u8#Intent;scheme=http;action=android.intent.action.VIEW;type=application/vnd.apple.mpegurl;end",
    );
  });

  it("keeps the scheme and the query of the address", () => {
    expect(androidIntentUrl("https://tv.example/hls/s1/external/index.m3u8?a=1")).toBe(
      "intent://tv.example/hls/s1/external/index.m3u8?a=1#Intent;scheme=https;action=android.intent.action.VIEW;type=application/vnd.apple.mpegurl;end",
    );
  });
});

describe("m3uFileName", () => {
  it("names the file after the stream", () => {
    expect(m3uFileName("Channel 12")).toBe("Channel 12.m3u");
  });

  it("leaves out what file systems refuse", () => {
    expect(m3uFileName('News: "24/7" <HD> | a\\b?*')).toBe("News 24 7 HD a b.m3u");
    expect(m3uFileName("two\nlines\tand a tab")).toBe("two lines and a tab.m3u");
    expect(m3uFileName("one\u{2028}two")).toBe("one two.m3u");
    expect(m3uFileName("  ..hidden")).toBe("hidden.m3u");
  });

  it("falls back to a plain name when nothing is left", () => {
    expect(m3uFileName("")).toBe("stream.m3u");
    expect(m3uFileName('?/ ..."')).toBe("stream.m3u");
  });

  it("cuts a long name, without cutting a character in half", () => {
    expect(m3uFileName("x".repeat(200))).toBe(`${"x".repeat(80)}.m3u`);
    const name = m3uFileName(`${"x".repeat(79)}😀😀`);
    expect(name).toBe(`${"x".repeat(79)}😀.m3u`);
  });
});

describe("m3uPlaylist", () => {
  it("lists the stream once, under its name", () => {
    expect(m3uPlaylist("Channel 12", PLAYLIST)).toBe(`#EXTM3U\n#EXTINF:-1,Channel 12\n${PLAYLIST}\n`);
  });

  it("keeps a name with a line break on one line, so that it can't add an entry", () => {
    expect(m3uPlaylist("Channel\r\nhttp://other.example/x", PLAYLIST)).toBe(
      `#EXTM3U\n#EXTINF:-1,Channel http://other.example/x\n${PLAYLIST}\n`,
    );
    // Unicode's own line and paragraph separators, and the next-line control character.
    expect(m3uPlaylist("One\u{2028}Two\u{2029}Three\u{85}Four", PLAYLIST)).toBe(
      `#EXTM3U\n#EXTINF:-1,One Two Three Four\n${PLAYLIST}\n`,
    );
  });
});

describe("handOffFor", () => {
  it("hands over through an app on Android", () => {
    expect(handOffFor("Channel 12", PLAYLIST, CHROME_ON_ANDROID_TV)).toEqual({
      kind: "app",
      url: PLAYLIST,
      link: androidIntentUrl(PLAYLIST),
    });
  });

  it("hands over a file to download elsewhere", () => {
    expect(handOffFor("Channel 12", PLAYLIST, CHROME_ON_LINUX)).toEqual({
      kind: "file",
      url: PLAYLIST,
      fileName: "Channel 12.m3u",
      content: m3uPlaylist("Channel 12", PLAYLIST),
    });
  });
});

describe("handOffMessage", () => {
  const file = handOffFor("Channel 12", PLAYLIST, CHROME_ON_LINUX);
  const app = handOffFor("Channel 12", PLAYLIST, CHROME_ON_ANDROID_TV);

  it("names the downloaded file and where to find it, and how to get to it from full screen", () => {
    expect(handOffMessage(file, true)).toEqual({
      title: "Sent to an external player",
      reason: `Open "Channel 12.m3u" from your browser's downloads to start it. Leave full screen to see them.\nOr open this address in your player: ${PLAYLIST}`,
    });
    expect(handOffMessage(file, false).reason).toBe(
      `Open "Channel 12.m3u" from your browser's downloads to start it.\nOr open this address in your player: ${PLAYLIST}`,
    );
  });

  it("says what to do when no app opens on Android", () => {
    expect(handOffMessage(app, true)).toEqual({
      title: "Sent to an external player",
      reason: `Pick a player if your device asks for one.\nIf none opens, open this address in your player: ${PLAYLIST}`,
    });
  });
});
