# ASOS Explorer

ASOS Explorer is a single-page web application for exploring Automated Surface Observing System (ASOS) station data via the [WindBorne Systems surface observations API](https://sfc.windbornesystems.com).

The experience focuses on three pillars:

- **Global discovery.** A Leaflet-powered map renders every station, supports free-text search, and can optionally jump to the nearest station to the viewer.
- **Historical insights.** Per-station weather observations are cleaned and visualised with multi-axis charts, summary metrics, and a detailed table. Corrupted rows are skipped automatically and surfaced in the UI.
- **Temporal exploration.** A calendar heat-view helps jump to any day of observations, highlights key stats (temperature, precipitation, wind), and feeds a focus date selector and CSV export.

## Running locally

This project is a static site. Any HTTP server that can serve the root directory will work. A couple of easy options:

### Using Python (3.9+)

```bash
python -m http.server 5173
```

Then visit [http://localhost:5173](http://localhost:5173) in your browser.

### Using Node.js (via `npx`)

```bash
npx serve .
```

## Hosting

Deploy the contents of this repository to any static host (Vercel, Netlify, GitHub Pages, Cloudflare Pages, etc.). No build step is required.

## Implementation highlights

- **Rate limiting & caching friendly.** A lightweight client-side token bucket ensures the WindBorne API limit of 20 requests/minute is respected even under rapid interactions.
- **Resilient parsing.** The historical weather parser normalises multiple potential field names, unit variants, and gracefully drops malformed records while reporting quality.
- **Rich visualisation.** Chart.js drives a combined line/bar chart with multiple y-axes covering temperature, wind, pressure, and precipitation in a single glance.
- **Calendar navigation.** Aggregated day-level summaries power a mini calendar for fast navigation and at-a-glance statistics.
- **CSV export.** Any filtered view (current focus date or entire series) can be downloaded as a CSV for further analysis.

## Notes

- The WindBorne API occasionally returns malformed payloads; the app will notify the viewer via a data-quality badge when rows are skipped.
- API calls are made directly from the browser. If you prefer to add a proxy for caching or additional retry logic, host it separately and update `API_BASE` in `app.js`.
- Because API rate limits are enforced client-side, extremely rapid station switching may still queue requests. A small badge in the UI communicates when data was cleaned.

## Submitting to WindBorne Systems

When your deployed instance is live, include its URL in the `submission_url` field of the application payload:

```json
{
  "career_application": {
    "name": "Your Name",
    "email": "you@example.com",
    "role": "Software Engineering Intern Product",
    "submission_url": "https://your-deployment.example.com",
    "portfolio_url": "https://your-portfolio.example.com",
    "resume_url": "https://your-resume.example.com",
    "notes": "Describe your background, interests, and any implementation notes you'd like to highlight."
  }
}
```

Send the payload with:

```bash
curl -X POST https://windbornesystems.com/career_applications.json \
  -H "Content-Type: application/json" \
  -d @application.json
```

Replace the placeholder values with your real information before submitting.
