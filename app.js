const API_BASE = 'https://sfc.windbornesystems.com';
const stationPanel = document.querySelector('#station-panel');
const calendarTitle = document.querySelector('#calendar-title');
const calendarGrid = document.querySelector('.calendar-grid');
const searchInput = document.querySelector('#station-search');
const suggestionsList = document.querySelector('#station-suggestions');
const locateButton = document.querySelector('#locate-me');
const prevMonthButton = document.querySelector('#prev-month');
const nextMonthButton = document.querySelector('#next-month');

let map;
let chart;
let panelElements = null;

const state = {
  stations: [],
  markers: new Map(),
  selectedStation: null,
  selectedMarker: null,
  historicalCache: new Map(),
  currentData: null,
  focusDate: null,
  calendarMonth: (() => {
    const d = new Date();
    d.setDate(1);
    return d;
  })(),
};

class RateLimiter {
  constructor(limit, intervalMs) {
    this.limit = limit;
    this.intervalMs = intervalMs;
    this.timestamps = [];
  }

  async run(task) {
    const now = Date.now();
    this.timestamps = this.timestamps.filter((ts) => now - ts < this.intervalMs);
    if (this.timestamps.length >= this.limit) {
      const wait = this.intervalMs - (now - this.timestamps[0]) + 50;
      await new Promise((resolve) => setTimeout(resolve, Math.max(wait, 150)));
      return this.run(task);
    }
    this.timestamps.push(Date.now());
    return task();
  }
}

const limiter = new RateLimiter(20, 60_000);

function showPanelMessage(title, message = '', extraClass = '') {
  stationPanel.innerHTML = '';
  const container = document.createElement('div');
  container.className = ['panel-placeholder', extraClass].filter(Boolean).join(' ');
  const heading = document.createElement('h2');
  heading.textContent = title;
  container.appendChild(heading);
  if (message) {
    const paragraph = document.createElement('p');
    paragraph.textContent = message;
    container.appendChild(paragraph);
  }
  stationPanel.appendChild(container);
}

async function fetchJson(path, { timeout = 15000 } = {}) {
  const url = `${API_BASE}${path}`;
  try {
    return await limiter.run(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const response = await fetch(url, {
          headers: {
            Accept: 'application/json',
          },
          signal: controller.signal,
          cache: 'no-store',
        });
        if (!response.ok) {
          throw new Error(`Request failed with ${response.status}`);
        }
        const text = await response.text();
        if (!text) return null;
        try {
          return JSON.parse(text);
        } catch (err) {
          console.warn('Failed to parse JSON', err);
          throw new Error('Received malformed JSON from upstream service');
        }
      } finally {
        clearTimeout(timer);
      }
    });
  } catch (err) {
    console.error(err);
    throw err;
  }
}

function normalizeStations(data) {
  const items = Array.isArray(data)
    ? data
    : Array.isArray(data?.stations)
    ? data.stations
    : [];

  const toNumber = (value, transform) => {
    if (value === null || value === undefined || value === '') return null;
    const num = Number(value);
    if (!Number.isFinite(num)) return null;
    return transform ? transform(num) : num;
  };

  const pickValue = (item, variants) => {
    for (const variant of variants) {
      if (typeof variant === 'string') {
        if (variant in item) {
          const value = toNumber(item[variant]);
          if (value !== null) return value;
        }
      } else if (variant && typeof variant === 'object') {
        if (variant.key in item) {
          const value = toNumber(item[variant.key], variant.transform);
          if (value !== null) return value;
        }
      }
    }
    return null;
  };

  const normalized = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const id =
      item.station_identifier ||
      item.station_id ||
      item.station ||
      item.icao ||
      item.id ||
      item.wmoid ||
      item.call ||
      null;
    const lat = pickValue(item, ['latitude', 'lat', 'latitude_deg']);
    const lon = pickValue(item, ['longitude', 'lon', 'longitude_deg']);
    if (id && Number.isFinite(lat) && Number.isFinite(lon)) {
      normalized.push({
        id: String(id).trim(),
        name: item.name || item.station_name || item.site || item.title || String(id).trim(),
        city: item.city || item.town || item.municipality || '',
        state: item.state || item.region || item.province || '',
        country: item.country || item.nation || item.cc || '',
        lat,
        lon,
        elevation_m:
          pickValue(item, [
            'elevation_m',
            'elevation_meter',
            'elevation',
            { key: 'elevation_ft', transform: (v) => v * 0.3048 },
          ]) ?? null,
        raw: item,
      });
    }
  }

  normalized.sort((a, b) => a.id.localeCompare(b.id));
  return normalized;
}

function normalizeHistorical(data) {
  const rows = Array.isArray(data)
    ? data
    : Array.isArray(data?.historical_weather)
    ? data.historical_weather
    : Array.isArray(data?.data)
    ? data.data
    : [];

  const toNumber = (value, transform) => {
    if (value === null || value === undefined || value === '') return null;
    const num = Number(value);
    if (!Number.isFinite(num)) return null;
    return transform ? transform(num) : num;
  };

  const pickValue = (item, variants) => {
    for (const variant of variants) {
      if (typeof variant === 'string') {
        if (variant in item) {
          const value = toNumber(item[variant]);
          if (value !== null) return value;
        }
      } else if (variant && typeof variant === 'object') {
        if (variant.key in item) {
          const value = toNumber(item[variant.key], variant.transform);
          if (value !== null) return value;
        }
      }
    }
    return null;
  };

  const normalized = [];
  let dropped = 0;
  for (const row of rows) {
    if (!row || typeof row !== 'object') {
      dropped += 1;
      continue;
    }
    const rawTime =
      row.time || row.timestamp || row.observation_time || row.valid_time || row.datetime || row.date_time;
    if (!rawTime) {
      dropped += 1;
      continue;
    }
    const parsedTime = new Date(rawTime);
    if (Number.isNaN(parsedTime.getTime())) {
      dropped += 1;
      continue;
    }
    const isoTime = parsedTime.toISOString();
    const dayKey = isoTime.slice(0, 10);
    const temp = pickValue(row, ['temp_c', 'temperature_c', 'air_temp_c', 'air_temperature_c']);
    const dew = pickValue(row, ['dewpoint_c', 'dew_point_c', 'dewpoint_temperature_c']);
    const windSpeed = pickValue(row, [
      'wind_speed_mps',
      'wind_speed_ms',
      'wind_speed',
      { key: 'wind_speed_kt', transform: (v) => v * 0.514444 },
      { key: 'wind_speed_kts', transform: (v) => v * 0.514444 },
    ]);
    const windGust = pickValue(row, [
      'wind_gust_mps',
      'wind_gust',
      { key: 'wind_gust_kt', transform: (v) => v * 0.514444 },
      { key: 'wind_gust_kts', transform: (v) => v * 0.514444 },
    ]);
    const pressure = pickValue(row, [
      'pressure_hpa',
      'sea_level_pressure_hpa',
      'altimeter_hpa',
      { key: 'altimeter_in_hg', transform: (v) => v * 33.8639 },
    ]);
    const precip = pickValue(row, [
      'precip_mm',
      'precipitation_mm',
      'precipitation',
      'precip_1hr_mm',
      { key: 'precip_in', transform: (v) => v * 25.4 },
    ]);

    if (
      temp === null &&
      dew === null &&
      windSpeed === null &&
      windGust === null &&
      pressure === null &&
      precip === null
    ) {
      normalized.push({
        time: parsedTime,
        isoTime,
        dayKey,
        temp_c: null,
        dewpoint_c: null,
        wind_speed_mps: null,
        wind_gust_mps: null,
        pressure_hpa: null,
        precip_mm: null,
        raw: row,
      });
      continue;
    }

    normalized.push({
      time: parsedTime,
      isoTime,
      dayKey,
      temp_c: temp,
      dewpoint_c: dew,
      wind_speed_mps: windSpeed,
      wind_gust_mps: windGust,
      pressure_hpa: pressure,
      precip_mm: precip,
      raw: row,
    });
  }

  normalized.sort((a, b) => a.time - b.time);

  return {
    rows: normalized,
    dropped,
    total: rows.length,
  };
}
function ensurePanel() {
  if (panelElements) return panelElements;
  const template = document.querySelector('#station-template');
  const fragment = template.content.cloneNode(true);
  stationPanel.innerHTML = '';
  stationPanel.appendChild(fragment);
  const root = stationPanel.querySelector('.station-details');
  const fields = {};
  root.querySelectorAll('[data-field]').forEach((node) => {
    fields[node.dataset.field] = node;
  });
  const dateInput = root.querySelector('#date-picker');
  const exportButton = root.querySelector('#export-csv');
  const tableBody = root.querySelector('tbody');
  const chartCanvas = root.querySelector('#weather-chart');
  chartCanvas.height = 340;
  chart = createChart(chartCanvas);
  dateInput.addEventListener('change', (event) => {
    state.focusDate = event.target.value || null;
    renderCalendar(state.currentData?.rows ?? []);
    updateFocusOutputs();
  });
  exportButton.addEventListener('click', handleExportCsv);
  panelElements = { root, fields, dateInput, exportButton, tableBody, chartCanvas };
  return panelElements;
}

function createChart(canvas) {
  const ctx = canvas.getContext('2d');
  return new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        {
          label: 'Temperature (°C)',
          data: [],
          borderColor: '#5bc0eb',
          backgroundColor: 'rgba(91, 192, 235, 0.25)',
          borderWidth: 2,
          tension: 0.3,
          spanGaps: true,
          yAxisID: 'temperature',
        },
        {
          label: 'Wind speed (m/s)',
          data: [],
          borderColor: '#f5a623',
          backgroundColor: 'rgba(245, 166, 35, 0.25)',
          borderWidth: 2,
          tension: 0.3,
          spanGaps: true,
          yAxisID: 'wind',
        },
        {
          label: 'Pressure (hPa)',
          data: [],
          borderColor: '#a18cff',
          backgroundColor: 'rgba(161, 140, 255, 0.18)',
          borderWidth: 2,
          tension: 0.25,
          spanGaps: true,
          yAxisID: 'pressure',
        },
        {
          label: 'Precipitation (mm)',
          data: [],
          type: 'bar',
          borderColor: 'rgba(91, 235, 193, 0.9)',
          backgroundColor: 'rgba(91, 235, 193, 0.4)',
          borderWidth: 1,
          yAxisID: 'precip',
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: 'index',
        intersect: false,
      },
      plugins: {
        legend: {
          labels: {
            color: '#f5f7fa',
            usePointStyle: true,
          },
        },
        tooltip: {
          callbacks: {
            title: (items) => {
              if (!items.length) return '';
              return new Date(items[0].label).toLocaleString();
            },
          },
        },
      },
      scales: {
        x: {
          ticks: {
            color: '#f5f7fa',
            maxRotation: 45,
            minRotation: 45,
          },
          grid: {
            color: 'rgba(255, 255, 255, 0.08)',
          },
        },
        temperature: {
          type: 'linear',
          position: 'left',
          ticks: {
            color: '#f5f7fa',
          },
          grid: {
            color: 'rgba(255, 255, 255, 0.12)',
          },
        },
        wind: {
          type: 'linear',
          position: 'right',
          ticks: {
            color: '#f5a623',
          },
          grid: {
            drawOnChartArea: false,
          },
        },
        pressure: {
          type: 'linear',
          position: 'right',
          ticks: {
            color: '#a18cff',
          },
          grid: {
            drawOnChartArea: false,
          },
        },
        precip: {
          type: 'linear',
          position: 'right',
          ticks: {
            color: '#5bebae',
          },
          grid: {
            drawOnChartArea: false,
          },
        },
      },
    },
  });
}

function formatNumber(value, { decimals = 1, fallback = '—' } = {}) {
  if (value === null || value === undefined || Number.isNaN(value)) return fallback;
  return Number(value).toFixed(decimals);
}

function formatCoordinate(value) {
  if (!Number.isFinite(value)) return '—';
  return `${value.toFixed(3)}°`;
}

function formatElevation(value) {
  if (value === null || value === undefined) return '—';
  const meters = Number(value);
  if (!Number.isFinite(meters)) return '—';
  const feet = meters * 3.28084;
  return `${meters.toFixed(0)} m (${feet.toFixed(0)} ft)`;
}

function filterRowsByFocus(rows) {
  if (!state.focusDate) return rows;
  return rows.filter((row) => row.dayKey === state.focusDate);
}

function computeStats(rows, key) {
  const values = rows.map((row) => row[key]).filter((value) => value !== null && value !== undefined);
  if (!values.length) return null;
  const sum = values.reduce((acc, value) => acc + value, 0);
  return {
    min: Math.min(...values),
    max: Math.max(...values),
    avg: sum / values.length,
    sum,
    count: values.length,
  };
}

function updateMetrics(rows) {
  const { fields } = ensurePanel();
  const tempStats = computeStats(rows, 'temp_c');
  fields['temp-range'].textContent = tempStats
    ? `High ${formatNumber(tempStats.max)}° • Low ${formatNumber(tempStats.min)}° • Avg ${formatNumber(tempStats.avg)}`
    : 'No temperature data';

  const windStats = computeStats(rows, 'wind_speed_mps');
  const gustStats = computeStats(rows, 'wind_gust_mps');
  fields['wind-range'].textContent = windStats
    ? `Avg ${formatNumber(windStats.avg)} m/s • Max ${formatNumber(windStats.max)} m/s` +
      (gustStats ? ` • Gust ${formatNumber(gustStats.max)} m/s` : '')
    : 'No wind data';

  const pressureStats = computeStats(rows, 'pressure_hpa');
  fields['pressure-range'].textContent = pressureStats
    ? `Avg ${formatNumber(pressureStats.avg)} hPa • Range ${formatNumber(pressureStats.min)}–${formatNumber(
        pressureStats.max
      )} hPa`
    : 'No pressure data';

  const precipStats = computeStats(rows, 'precip_mm');
  fields['precip-total'].textContent = precipStats
    ? `Total ${formatNumber(precipStats.sum, { decimals: 2 })} mm • Max hourly ${formatNumber(
        precipStats.max,
        { decimals: 2 }
      )} mm`
    : 'No precipitation data';
}

function updateChart(rows) {
  if (!chart) return;
  chart.data.labels = rows.map((row) => row.isoTime);
  chart.data.datasets[0].data = rows.map((row) => row.temp_c);
  chart.data.datasets[1].data = rows.map((row) => row.wind_speed_mps);
  chart.data.datasets[2].data = rows.map((row) => row.pressure_hpa);
  chart.data.datasets[3].data = rows.map((row) => row.precip_mm ?? 0);
  chart.update();
}

function updateTable(rows) {
  const { tableBody } = ensurePanel();
  tableBody.innerHTML = '';
  if (!rows.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 6;
    cell.textContent = 'No observations available for the selected range.';
    row.appendChild(cell);
    tableBody.appendChild(row);
    return;
  }
  for (const entry of rows) {
    const row = document.createElement('tr');
    const timeCell = document.createElement('td');
    timeCell.textContent = entry.time.toLocaleString();
    row.appendChild(timeCell);

    const tempCell = document.createElement('td');
    tempCell.textContent = entry.temp_c === null ? '—' : formatNumber(entry.temp_c);
    row.appendChild(tempCell);

    const windCell = document.createElement('td');
    windCell.textContent = entry.wind_speed_mps === null ? '—' : formatNumber(entry.wind_speed_mps);
    row.appendChild(windCell);

    const gustCell = document.createElement('td');
    gustCell.textContent = entry.wind_gust_mps === null ? '—' : formatNumber(entry.wind_gust_mps);
    row.appendChild(gustCell);

    const pressureCell = document.createElement('td');
    pressureCell.textContent = entry.pressure_hpa === null ? '—' : formatNumber(entry.pressure_hpa);
    row.appendChild(pressureCell);

    const precipCell = document.createElement('td');
    precipCell.textContent = entry.precip_mm === null ? '—' : formatNumber(entry.precip_mm, { decimals: 2 });
    row.appendChild(precipCell);

    tableBody.appendChild(row);
  }
}

function updateQualityBadge(data) {
  const { fields } = ensurePanel();
  const badge = fields.quality;
  if (!data || !data.total) {
    badge.textContent = 'No data';
    badge.dataset.status = 'warning';
    return;
  }
  const kept = data.rows.length;
  const dropCount = data.dropped + Math.max(0, data.total - kept - data.dropped);
  const cleanPercent = Math.round((kept / data.total) * 100);
  if (dropCount > 0) {
    badge.textContent = `Cleaned ${cleanPercent}% (skipped ${dropCount})`;
    badge.dataset.status = 'warning';
  } else {
    badge.textContent = `Complete (${cleanPercent}% valid)`;
    badge.dataset.status = 'ok';
  }
}

function updateMetadata(station) {
  const { fields } = ensurePanel();
  fields.name.textContent = station.name;
  const locationParts = [station.city, station.state || station.country].filter(Boolean);
  fields.location.textContent = locationParts.join(', ');
  fields.identifier.textContent = station.id;
  fields.coords.textContent = `${formatCoordinate(station.lat)} / ${formatCoordinate(station.lon)}`;
  fields.elevation.textContent = formatElevation(station.elevation_m);
}

function getFocusedRows() {
  if (!state.currentData) return [];
  return filterRowsByFocus(state.currentData.rows);
}

function updateFocusOutputs() {
  if (!state.currentData) return;
  const focusedRows = getFocusedRows();
  updateMetrics(focusedRows);
  updateTable(focusedRows);
  updateChart(focusedRows);
  highlightCalendarSelection();
}

function handleExportCsv() {
  const rows = getFocusedRows();
  if (!rows.length) {
    window.alert('No rows to export for the selected range.');
    return;
  }
  const header = ['time_iso', 'temperature_c', 'dewpoint_c', 'wind_speed_mps', 'wind_gust_mps', 'pressure_hpa', 'precip_mm'];
  const lines = [header.join(',')];
  for (const row of rows) {
    const values = [
      row.isoTime,
      row.temp_c ?? '',
      row.dewpoint_c ?? '',
      row.wind_speed_mps ?? '',
      row.wind_gust_mps ?? '',
      row.pressure_hpa ?? '',
      row.precip_mm ?? '',
    ];
    lines.push(values.join(','));
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  const suffix = state.focusDate ? state.focusDate : 'all';
  link.download = `${state.selectedStation?.id ?? 'station'}_${suffix}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function aggregateByDay(rows) {
  const map = new Map();
  for (const row of rows) {
    const day = row.dayKey;
    if (!map.has(day)) {
      map.set(day, {
        temps: [],
        winds: [],
        gusts: [],
        pressures: [],
        precip: 0,
        count: 0,
      });
    }
    const agg = map.get(day);
    agg.count += 1;
    if (row.temp_c !== null && row.temp_c !== undefined) agg.temps.push(row.temp_c);
    if (row.wind_speed_mps !== null && row.wind_speed_mps !== undefined) agg.winds.push(row.wind_speed_mps);
    if (row.wind_gust_mps !== null && row.wind_gust_mps !== undefined) agg.gusts.push(row.wind_gust_mps);
    if (row.pressure_hpa !== null && row.pressure_hpa !== undefined) agg.pressures.push(row.pressure_hpa);
    if (row.precip_mm !== null && row.precip_mm !== undefined) agg.precip += row.precip_mm;
  }
  return map;
}

function buildCalendarSummary(agg) {
  const parts = [];
  if (agg.temps.length) {
    const min = Math.min(...agg.temps);
    const max = Math.max(...agg.temps);
    parts.push(`H ${formatNumber(max)}° / L ${formatNumber(min)}°`);
  }
  if (agg.precip > 0.01) {
    parts.push(`${formatNumber(agg.precip, { decimals: 2 })} mm precip`);
  }
  if (agg.winds.length) {
    const avg = agg.winds.reduce((acc, value) => acc + value, 0) / agg.winds.length;
    parts.push(`Wind ${formatNumber(avg)} m/s`);
  }
  if (!parts.length) {
    parts.push(`${agg.count} obs`);
  }
  return parts.join(' • ');
}
function renderCalendar(rows = []) {
  if (!state.selectedStation) {
    calendarTitle.textContent = 'Select a station to view the calendar';
    calendarGrid.classList.add('empty-state');
    calendarGrid.innerHTML = '<p>Choose a station to populate the calendar summary.</p>';
    return;
  }

  calendarGrid.classList.remove('empty-state');
  const month = new Date(state.calendarMonth);
  const year = month.getFullYear();
  const monthIndex = month.getMonth();
  calendarTitle.textContent = `${month.toLocaleString(undefined, {
    month: 'long',
    year: 'numeric',
  })} • ${state.selectedStation.id}`;

  const aggregated = aggregateByDay(rows);
  calendarGrid.innerHTML = '';
  const firstDayOfMonth = new Date(year, monthIndex, 1);
  const startWeekday = firstDayOfMonth.getDay();
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();

  for (let i = 0; i < startWeekday; i += 1) {
    const emptyCell = document.createElement('div');
    emptyCell.className = 'day empty';
    calendarGrid.appendChild(emptyCell);
  }

  for (let day = 1; day <= daysInMonth; day += 1) {
    const dayKey = `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const agg = aggregated.get(dayKey);
    const cell = document.createElement('div');
    cell.className = 'day';
    if (state.focusDate === dayKey) {
      cell.dataset.active = 'true';
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = String(day);
    button.addEventListener('click', () => {
      state.focusDate = dayKey;
      if (panelElements?.dateInput) {
        panelElements.dateInput.value = dayKey;
      }
      updateFocusOutputs();
    });
    cell.appendChild(button);
    const summarySpan = document.createElement('span');
    summarySpan.textContent = agg ? buildCalendarSummary(agg) : 'No data';
    cell.appendChild(summarySpan);
    calendarGrid.appendChild(cell);
  }
}

function findStation(query) {
  if (!query) return null;
  const cleaned = query.trim().toLowerCase();
  return (
    state.stations.find((station) => {
      const haystack = [
        station.id,
        station.name,
        station.city,
        station.state,
        station.country,
      ]
        .filter(Boolean)
        .map((value) => value.toLowerCase());
      return haystack.some((value) => value.includes(cleaned));
    }) || null
  );
}

function setActiveMarker(station) {
  if (state.selectedMarker) {
    state.selectedMarker.setStyle({
      radius: 5,
      color: '#5bc0eb',
      fillColor: '#5bc0eb',
      weight: 1,
    });
  }
  const marker = state.markers.get(station.id);
  if (marker) {
    marker.setStyle({
      radius: 8,
      color: '#ffffff',
      fillColor: '#5bc0eb',
      weight: 2,
    });
    state.selectedMarker = marker;
  }
}

function getCacheKey(stationId) {
  return `hist:${stationId}`;
}

async function loadHistoricalData(station) {
  const cacheKey = getCacheKey(station.id);
  if (state.historicalCache.has(cacheKey)) {
    return state.historicalCache.get(cacheKey);
  }
  const promise = fetchJson(`/historical_weather?station=${encodeURIComponent(station.id)}`)
    .then((data) => normalizeHistorical(data ?? []))
    .catch((error) => {
      state.historicalCache.delete(cacheKey);
      throw error;
    });
  state.historicalCache.set(cacheKey, promise);
  return promise;
}

function toMonthStart(dateLike) {
  const date = new Date(dateLike);
  date.setHours(0, 0, 0, 0);
  date.setDate(1);
  return date;
}

function pickDefaultFocusDate(rows) {
  if (!rows.length) return null;
  const latest = rows[rows.length - 1];
  return latest.dayKey;
}

async function selectStation(station, { panTo = true } = {}) {
  state.selectedStation = station;
  setActiveMarker(station);
  if (panTo) {
    map.flyTo([station.lat, station.lon], Math.max(map.getZoom(), 5));
  }
  showPanelMessage('Loading station…', 'Fetching historical weather observations.');
  try {
    const data = await loadHistoricalData(station);
    state.currentData = data;
    state.focusDate = pickDefaultFocusDate(data.rows);
    if (state.focusDate) {
      state.calendarMonth = toMonthStart(state.focusDate);
    } else {
      const fallback = data.rows[0]?.time ?? new Date();
      state.calendarMonth = toMonthStart(fallback);
    }
    renderStationDetails(station, data);
    renderCalendar(data.rows);
    updateFocusOutputs();
    searchInput.value = `${station.id} — ${station.name}`;
  } catch (error) {
    console.error(error);
    showPanelMessage('Unable to load historical data', 'Please try another station or refresh the page.', 'error');
  }
}

function renderStationDetails(station, data) {
  ensurePanel();
  updateMetadata(station);
  const { dateInput } = panelElements;
  if (data.rows.length) {
    dateInput.min = data.rows[0].dayKey;
    dateInput.max = data.rows[data.rows.length - 1].dayKey;
  } else {
    dateInput.removeAttribute('min');
    dateInput.removeAttribute('max');
  }
  if (state.focusDate && data.rows.some((row) => row.dayKey === state.focusDate)) {
    dateInput.value = state.focusDate;
  } else if (data.rows.length) {
    const fallback = pickDefaultFocusDate(data.rows);
    state.focusDate = fallback;
    dateInput.value = fallback ?? '';
  } else {
    dateInput.value = '';
  }
  updateQualityBadge(data);
}

function createMarker(station) {
  const marker = L.circleMarker([station.lat, station.lon], {
    radius: 5,
    color: '#5bc0eb',
    fillColor: '#5bc0eb',
    fillOpacity: 0.9,
    weight: 1,
  });
  marker.bindPopup(
    `<strong>${station.name}</strong><br/>${station.city ? `${station.city}, ` : ''}${
      station.state || station.country || ''
    }<br/>${station.id}`
  );
  marker.on('click', () => selectStation(station));
  marker.addTo(map);
  state.markers.set(station.id, marker);
}

function updateMapBounds() {
  const group = L.featureGroup(Array.from(state.markers.values()));
  if (group.getLayers().length) {
    map.fitBounds(group.getBounds().pad(0.2));
  }
}

function formatStationForList(station) {
  const location = [station.city, station.state || station.country].filter(Boolean).join(', ');
  return location ? `${station.name} — ${location}` : station.name;
}

function populateSearchAssist() {
  const datalist = suggestionsList;
  datalist.innerHTML = '';
  const fragment = document.createDocumentFragment();
  for (const station of state.stations) {
    const option = document.createElement('option');
    option.value = `${station.id} — ${formatStationForList(station)}`;
    fragment.appendChild(option);
  }
  datalist.appendChild(fragment);
}

function attachEventListeners() {
  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      const station = findStation(searchInput.value);
      if (station) {
        selectStation(station, { panTo: true });
      } else {
        window.alert('No matching station found. Try another identifier, name, or city.');
      }
    }
  });

  searchInput.addEventListener('change', () => {
    const station = findStation(searchInput.value);
    if (station) {
      selectStation(station, { panTo: true });
    }
  });

  locateButton.addEventListener('click', () => {
    if (!navigator.geolocation) {
      window.alert('Geolocation is not available in this browser.');
      return;
    }
    locateButton.disabled = true;
    navigator.geolocation.getCurrentPosition(
      (position) => {
        locateButton.disabled = false;
        const { latitude, longitude } = position.coords;
        const nearest = findNearestStation(latitude, longitude);
        if (nearest) {
          selectStation(nearest, { panTo: true });
        } else {
          window.alert('No nearby station found. Try searching by identifier or city.');
        }
      },
      () => {
        locateButton.disabled = false;
        window.alert('We could not access your location.');
      },
      { enableHighAccuracy: false, timeout: 10000 }
    );
  });

  prevMonthButton.addEventListener('click', () => {
    const month = new Date(state.calendarMonth);
    month.setMonth(month.getMonth() - 1);
    state.calendarMonth = month;
    renderCalendar(state.currentData?.rows ?? []);
    highlightCalendarSelection();
  });

  nextMonthButton.addEventListener('click', () => {
    const month = new Date(state.calendarMonth);
    month.setMonth(month.getMonth() + 1);
    state.calendarMonth = month;
    renderCalendar(state.currentData?.rows ?? []);
    highlightCalendarSelection();
  });
}

function findNearestStation(lat, lon) {
  if (!state.stations.length) return null;
  const toRad = (value) => (value * Math.PI) / 180;
  const R = 6371;
  let best = null;
  let bestDistance = Infinity;
  for (const station of state.stations) {
    const dLat = toRad(station.lat - lat);
    const dLon = toRad(station.lon - lon);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(lat)) * Math.cos(toRad(station.lat)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const distance = R * c;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = station;
    }
  }
  return best;
}

async function loadStations() {
  showPanelMessage('Loading stations…', 'Fetching station catalog and preparing the map.');
  try {
    const response = await fetchJson('/stations');
    const stations = normalizeStations(response ?? []);
    state.stations = stations;
    for (const station of stations) {
      createMarker(station);
    }
    updateMapBounds();
    populateSearchAssist();
    renderCalendar();
    showPanelMessage('Select a station', 'Tap a marker or use the search above.');
  } catch (error) {
    console.error(error);
    showPanelMessage(
      'Unable to load stations',
      'We could not reach the WindBorne station service. Refresh to try again.',
      'error'
    );
  }
}

function initMap() {
  map = L.map('map', {
    center: [20, 0],
    zoom: 2,
    worldCopyJump: true,
    zoomControl: false,
  });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(map);
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  window.setTimeout(() => map.invalidateSize(), 500);
}

function highlightLatest() {
  if (!state.currentData || !state.currentData.rows.length) return;
  if (!state.focusDate) {
    state.focusDate = pickDefaultFocusDate(state.currentData.rows);
  }
  renderCalendar(state.currentData.rows);
  updateFocusOutputs();
}

async function bootstrap() {
  initMap();
  attachEventListeners();
  renderCalendar();
  await loadStations();
  highlightLatest();
}

function highlightCalendarSelection() {
  const cells = calendarGrid.querySelectorAll('.day');
  cells.forEach((cell) => {
    if (!cell.classList.contains('empty')) {
      const button = cell.querySelector('button');
      if (!button) return;
      const day = button.textContent;
      const month = state.calendarMonth;
      const year = month.getFullYear();
      const monthIndex = month.getMonth();
      const dayKey = `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      if (state.focusDate === dayKey) {
        cell.dataset.active = 'true';
      } else {
        cell.removeAttribute('data-active');
      }
    }
  });
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.selectedStation) {
    renderCalendar(state.currentData?.rows ?? []);
    highlightCalendarSelection();
  }
});

bootstrap();
