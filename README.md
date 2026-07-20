# Mindat Specimen Photo Finder

**[→ Open the tool](https://crawlerkarl.github.io/mindat-photo-finder/)**

Find mineral specimen photos on [mindat.org](https://www.mindat.org) showing **one mineral
pictured with another** — *fluorite with calcite*, *azurite with malachite*, *wulfenite with
mimetite* — optionally narrowed to a region and a photo type.

Mindat's photo search can already run this query. It just never presents it that way: the
field you need is labelled *"Keywords in Description"*, which doesn't read as *"and this other
mineral is in the shot."* This page is a thin, honest front end over that same search.

## What it does

- **Pairs two minerals** in one query, with autocomplete over ~200 common species.
- **Resolves varieties to parent species** — type *Amethyst* and it points out that Mindat files
  those photos under *Quartz*, with one-click switching. Same for Aquamarine→Beryl,
  Ruby→Corundum, Kunzite→Spodumene, and ~40 more.
- **Runs it both ways.** The two fields search *different things* (see below), so the tool offers
  the swapped query and an **Open both** button. The union is the honest answer.
- **Real photo-type filters** — UV fluorescence (short/mid/long wave), close-up/photomicrograph,
  specimen in situ, cut & rough gem material, SEM, polished section.
- **Shows the URL it builds**, so you can copy, bookmark, or script it.
- Light and dark themes, works on a phone.

## Why there are two searches

The two inputs don't hit the same index:

| Field | Matches |
| --- | --- |
| **Primary mineral** | Mindat's *structured species list* for the photo — reliable, but only one mineral fits here |
| **Associate mineral** | the *caption text* — so it only finds photos where the photographer actually wrote that name |

Because of that asymmetry, `Fluorite` + "calcite" and `Calcite` + "fluorite" return overlapping
but different sets. Running both and merging is the complete answer — hence **Open both**.

It also means a third mineral needs its own query: the caption field matches a **phrase**, not a
set of keywords. `text=calcite barite` looks for that exact string, not "both minerals present."

**Known limit:** recall depends on photographers naming associates in their captions. Mindat
clearly stores structured species lists per photo (it prints them on every result), but neither
the search form nor the public API exposes a two-species structured query. This tool cannot beat
Mindat's recall — only its ergonomics.

## Three or more minerals — the bookmarklet

Mindat has no AND search, so no URL can intersect 3+ minerals. The
**Multi-Mineral Finder bookmarklet** (install from the tool page) does it from
inside your own mindat.org session:

1. **Probe** — for each mineral as a caption term, page-1 counts pick the
   cheapest structural anchor among the others.
2. **Sweep** — fetch every result page of each pairing, sequentially,
   ~0.8 s apart (ordinary page views in your session; hard 900-page cap,
   confirmation above 250, pause/stop any time, auto-pause if Mindat's bot
   protection interjects).
3. **Verify** — parse each row's structured species links (the ones Mindat
   prints on every result) and keep only photos carrying **all** wanted
   minerals; spelling variants (Baryte/Barite, Sulphur/Sulfur) are normalized.
4. **Union** — dedupe across sweeps by photo id; live thumbnail grid,
   CSV export, copy-links.

Completeness, honestly stated: the *verification* is exact, but *discovery*
rides on captions — a photo whose caption names none of your minerals cannot
be found this way. The panel repeats this on every finished run.

Example run: Fluorite + Baryte + Sphalerite in Tennessee → 82 specimen photos
in ~3 minutes (36 page views).

## How it works

It builds a `photosearch.php` query string and opens it on mindat.org:

```
https://www.mindat.org/photosearch.php
  ?frm_id=mls&cform_is_valid=1
  &minname=Fluorite      # structured species match
  &text=Calcite          # caption text match
  &region=Illinois       # matches at any hierarchy level
  &phototype=M&mtype=9   # 9 = UV fluorescence, shortwave
  &sort=2                # newest first
  &cf_mls_page=1&potd=0&submit_mls=Search
```

`mtype` values were read directly from Mindat's own form: `1` full view, `2` close-up,
`6` polished section, `9`/`10`/`11` UV SW/MW/LW, `13` in situ, `29` SEM, `38` gem rough.

## What it does not do

**No scraping, no storage, no redistribution.** This is one static HTML file with no backend and
no build step. It never fetches from mindat.org — it constructs a link and hands you off. Every
photo you see is served by Mindat in a normal page view, under its own photographer's licence.
Mindat photos are individually copyrighted and are **not** covered by Mindat's API data licence.

Not affiliated with or endorsed by Mindat. Mineral data © mindat.org and the Hudson Institute of
Mineralogy — a 501(c)(3) non-profit worth [supporting](https://www.mindat.org/donate.php).

> Ralph, J., Von Bargen, D., Martynov, P., Zhang, J., Que, X., Prabhu, A., Morrison, S. M., Li, W.,
> Chen, W., & Ma, X. (2025). Mindat.org: The open access mineralogy database to accelerate
> data-intensive geoscience research. *American Mineralogist*, 110(6), 833–844.

## Running it locally

No dependencies:

```
git clone https://github.com/CrawlerKarl/mindat-photo-finder.git
open mindat-photo-finder/index.html
```

## Licence

MIT — see [LICENSE](LICENSE).
