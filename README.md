# Tsukihime

A [Seanime](https://seanime.app) anime torrent provider that uses the
[Tsukihime API](https://api.tsukihime.org/v1/docs) to find anime torrents
aggregated from nyaa, nekobt and sukebei.

## Features

- **Smart search** by AniList ID: resolves the media to Tsukihime's catalogue for confirmed matches, with batch / episode / resolution filters and an editable title override.
- **Free-text search** for manual queries.
- **Latest feed**, so it can be used as a default provider and by the Auto Downloader (`type: "main"`).
- **Real seeders / leechers**, populated per result from Tsukihime's tracker data (see [Configuration](#configuration)).
- **Magnet links** built from each torrent's info hash, with the trackers Tsukihime reports for it.
- **Optional adult content**, off by default and gated behind a switch.

## Install

In Seanime, go to **Extensions**, select **Add extension**, and paste:

```
https://raw.githubusercontent.com/Crashdaemon/Seanime-Tsukihime/main/tsukihime.json
```

## Configuration

| Setting | Default | Description |
|---|---|---|
| **Tsukihime API base URL** | `https://api.tsukihime.org/v1` | Override if you run a mirror/proxy. |
| **Include adult (sukebei) results** | `false` | When on, includes `is_adult` / sukebei torrents (Seanime still gates by the media's own NSFW flag). |
| **Fetch seeders** | `false` | Off by default. When on, each returned candidate triggers a per-torrent request to read its seeders/leechers and trackers, and results are ranked by seeders. Slower, and note most Tsukihime torrents (nyaa-sourced) have no seeder data, so many will still show 0. Off = faster searches with seeders left at 0. |
| **Max results returned per search** | `50` | How many results are returned (and shown) per search. |
| **Smart-search scan depth** | `100` | How many candidate torrents are considered per search before trimming to the value above (helps shows with many releases). When **Fetch seeders** is on, this also bounds the number of per-torrent requests made. Capped at 1000. |

## Notes and limitations

- Seeders/leechers and tracker lists live only on Tsukihime's per-torrent detail endpoint and are off by default (see **Fetch seeders**). Tsukihime also only has this data for some sources (mainly nekobt); most nyaa-sourced releases report no seeders at all, so even with the toggle on many results show 0. A "0" therefore means "unknown", not "dead".
- Magnet trackers also come from that per-torrent data, so with seeder fetching off (or when Tsukihime reports none), magnets rely on DHT and peer exchange.
- Per-episode matching is best-effort: many releases are season batches and Tsukihime's episode data is sparse.
- Tsukihime does not expose download counts or "best release" data, so those are left for Seanime to infer.

## Credits

Torrent metadata is provided by [Tsukihime](https://tsukihime.org/). This extension is an unofficial
client and is not affiliated with Tsukihime.
