# Lead Hunt

A local dashboard that looks for small businesses in a US city that seem to have no working website, scores them, and drafts a first message for each one.

It runs on your machine. One Python file, one HTML file, no packages to install.

![Lead Hunt scanning a city](docs/demo.gif)

The clip above and the full 38 second walkthrough in `lead-hunt-demo.mp4` were recorded in sample mode, so the businesses in them are generated. Run the server to see real ones.

## Run it

You need Python 3.9 or newer.

```bash
python server.py
```

Open http://127.0.0.1:8765, type a city like `Austin, TX`, press **Start hunt**.

The first search of a city takes about half a minute, because the free map service allows one request per second. Results are cached in `.cache/` for 24 hours.

If you open `lead-hunt.html` directly as a file, it runs in sample mode with generated data. The badge in the top right always says which mode you are in.

## What it does

1. Finds the city on OpenStreetMap and collects businesses within 7 km of the center in five categories: hair, auto repair, dentists, beauty, laundry.
2. Groups them into up to six areas and keeps the 14 closest to each area's center.
3. Checks every listed website. A site counts as dead only when the domain does not resolve, the connection is refused, or the server answers 404, 410 or 5xx.
4. Scores each business and drafts a first message for the ones with a website gap.

You can click any dot to see the score breakdown, copy the message, or download all leads as CSV.

## How the score works

Every business starts at 20. Signals add points, the total is capped at 99, and 70 or more with a website gap counts as a qualified lead.

| Signal | Points | Source |
| --- | --- | --- |
| No website listed | 40 | OpenStreetMap |
| Website does not load | 32 | live check |
| Only a social page | 25 | OpenStreetMap |
| Phone number listed | 12 | OpenStreetMap |
| 100+ reviews | 10 | Google Places |
| Reviews mention calling or hours | 8 | Google Places |
| No opening hours listed | 6 | OpenStreetMap |
| Rated 4.5 or higher | 6 | Google Places |

The numbers live in `SIGNALS` at the top of the script in `lead-hunt.html`.

## Read this before you trust a lead

**"No website listed" means the map listing has no website, not that the business has none.** OpenStreetMap is edited by volunteers and is often incomplete. In a test run on Austin, 59 of 81 businesses had no website on the map. Many of them certainly have one. Open the listing and search the name before you write to anyone.

Adding a Google Places key fixes most of this: a website found by Google removes the signal.

## Optional: Google Places

Copy `.env.example` to `.env` and set `GOOGLE_PLACES_API_KEY`. The server then asks Google about each candidate lead and adds the rating, the review count and one review sentence that mentions calling, hours, prices or booking.

Google bills for these requests. `GOOGLE_MAX_CALLS` caps them per search (40 by default). This part was written from Google's documentation and has not been run against a live key yet.

## Limits

- The message is a template. Rewrite it in your own voice before sending.
- Nothing is sent for you. The tool only finds and drafts.
- Cold outreach is regulated. In the US read up on CAN-SPAM first, and keep the volume small.
- Follow the usage policies of [Nominatim](https://operations.osmfoundation.org/policies/nominatim/) and Google Places. Map data © OpenStreetMap contributors.

## Files

- `server.py` - local server: map search, website checks, Google Places, cache
- `lead-hunt.html` - the dashboard, including the sample data and the scoring table
- `.env.example` - optional settings

Add `?demo=2` to the address to play a scripted walkthrough for screen recording. The number is the speed.

## Ideas for what to add next

- More categories: edit `NICHES` in `server.py`, each one is a search phrase plus the OpenStreetMap tag it must match.
- Other countries: the search works anywhere OpenStreetMap has data, only the wording of the messages is US-flavored.
- Messages written by a language model from the real review, instead of the template.

## Author

Built by [@sgarlen01](https://x.com/sgarlen01) with Claude. I post what I build and what it actually does on X.

MIT license, see `LICENSE`.
