import React, { useEffect, useState, useCallback } from 'react';
import Card, { CardHeader, CardTitle } from './common/Card';
import { Icon } from './common/Icon';

// ── Types matching your backend's WeatherData model ──────────────────────────
interface WeatherData {
  temperature: number;
  wind_speed: number;
  rain: number;
  humidity: number;
  pressure: number;
  fetched_at: string | null;
}

interface EnvironmentalResponse {
  station_a: WeatherData;
  station_b: WeatherData;
  user_location?: WeatherData | null;
  user_lat?: number | null;
  user_lon?: number | null;
}

// ── Config ───────────────────────────────────────────────────────────────────
const BACKEND_URL = import.meta.env.VITE_BACKEND_URL ?? 'http://localhost:8000';
const REFRESH_INTERVAL_MS = 5 * 60 * 1000; // match backend's 5-min auto-refresh

// ── Sub-components ───────────────────────────────────────────────────────────
const WeatherDataPoint: React.FC<{
  icon: string;
  label: string;
  valueA: string;
  valueB: string;
  severity?: 'green' | 'yellow' | 'red';
}> = ({ icon, label, valueA, valueB, severity = 'green' }) => {
  const severityClasses = {
    green: 'text-accent-green',
    yellow: 'text-accent-yellow',
    red: 'text-accent-red',
  };
  return (
    <div className="flex items-center justify-between text-sm">
      <div className="flex items-center">
        <Icon name={icon} className={`w-5 h-5 mr-2 ${severityClasses[severity]}`} />
        <span className="text-text-light-secondary dark:text-text-dark-secondary">{label}</span>
      </div>
      <div className="font-semibold text-right">
        <span>{valueA}</span> / <span>{valueB}</span>
      </div>
    </div>
  );
};

// ── Helpers ──────────────────────────────────────────────────────────────────
const getWindSeverity = (speed: number): 'green' | 'yellow' | 'red' => {
  if (speed > 35) return 'red';
  if (speed > 25) return 'yellow';
  return 'green';
};

const fmt1 = (n: number) => n.toFixed(1);

// ── Main Component ───────────────────────────────────────────────────────────
interface EnvironmentalPanelProps {
  /** Optional: pass browser geolocation to get user-location weather too */
  userLat?: number;
  userLon?: number;
  /** Override polling interval (ms). Defaults to 5 min. */
  refreshInterval?: number;
}

const EnvironmentalPanel: React.FC<EnvironmentalPanelProps> = ({
  userLat,
  userLon,
  refreshInterval = REFRESH_INTERVAL_MS,
}) => {
  const [data, setData] = useState<EnvironmentalResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastFetched, setLastFetched] = useState<Date | null>(null);

  const fetchEnvironmental = useCallback(async () => {
    try {
      const res = await fetch(`${BACKEND_URL}/environmental-data`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lat: userLat ?? null,
          lon: userLon ?? null,
        }),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

      const json: EnvironmentalResponse = await res.json();
      setData(json);
      setError(null);
      setLastFetched(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch environmental data');
    } finally {
      setLoading(false);
    }
  }, [userLat, userLon]);

  // Initial fetch + polling
  useEffect(() => {
    fetchEnvironmental();
    const interval = setInterval(fetchEnvironmental, refreshInterval);
    return () => clearInterval(interval);
  }, [fetchEnvironmental, refreshInterval]);

  // ── Render: loading ────────────────────────────────────────────────────────
  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Environmental</CardTitle>
        </CardHeader>
        <div className="p-4 text-xs italic text-center text-text-light-secondary dark:text-text-dark-secondary">
          Fetching weather data…
        </div>
      </Card>
    );
  }

  // ── Render: error ──────────────────────────────────────────────────────────
  if (error || !data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Environmental</CardTitle>
        </CardHeader>
        <div className="p-4 text-xs text-center text-accent-red">
          {error ?? 'No data available'}
          <button
            onClick={fetchEnvironmental}
            className="block mx-auto mt-2 text-xs underline text-text-light-secondary dark:text-text-dark-secondary"
          >
            Retry
          </button>
        </div>
      </Card>
    );
  }

  const { station_a: a, station_b: b, user_location: u } = data;
  const maxWind = Math.max(a.wind_speed, b.wind_speed);

  // ── Render: data ───────────────────────────────────────────────────────────
  return (
    <Card>
      <CardHeader>
        <CardTitle>Environmental</CardTitle>
        <div className="flex flex-col items-end gap-0.5">
          <div className="text-xs text-text-light-secondary dark:text-text-dark-secondary">
            STA A / STA B
          </div>
          {lastFetched && (
            <div className="text-[10px] text-text-light-secondary dark:text-text-dark-secondary opacity-60">
              Updated {lastFetched.toLocaleTimeString()}
            </div>
          )}
        </div>
      </CardHeader>

      <div className="space-y-3">
        <WeatherDataPoint
          icon="temperature"
          label="Temp"
          valueA={`${fmt1(a.temperature)}°C`}
          valueB={`${fmt1(b.temperature)}°C`}
        />
        <WeatherDataPoint
          icon="wind"
          label="Wind"
          valueA={`${fmt1(a.wind_speed)} km/h`}
          valueB={`${fmt1(b.wind_speed)} km/h`}
          severity={getWindSeverity(maxWind)}
        />
        <WeatherDataPoint
          icon="rain"
          label="Rain"
          valueA={`${fmt1(a.rain)} mm/h`}
          valueB={`${fmt1(b.rain)} mm/h`}
          severity={a.rain > 5 || b.rain > 5 ? 'yellow' : 'green'}
        />
        <WeatherDataPoint
          icon="humidity"
          label="Humidity"
          valueA={`${Math.round(a.humidity)}%`}
          valueB={`${Math.round(b.humidity)}%`}
        />
        <WeatherDataPoint
          icon="pressure"
          label="Pressure"
          valueA={`${Math.round(a.pressure)} hPa`}
          valueB={`${Math.round(b.pressure)} hPa`}
        />
      </div>

      {/* Optional: user location row */}
      {u && (
        <div className="mt-4 pt-3 border-t border-border-light dark:border-border-dark">
          <div className="text-xs font-semibold mb-2 text-text-light-secondary dark:text-text-dark-secondary">
            Your Location
          </div>
          <div className="grid grid-cols-2 gap-1 text-xs">
            <span className="text-text-light-secondary dark:text-text-dark-secondary">Temp</span>
            <span className="font-semibold text-right">{fmt1(u.temperature)}°C</span>
            <span className="text-text-light-secondary dark:text-text-dark-secondary">Wind</span>
            <span className="font-semibold text-right">{fmt1(u.wind_speed)} km/h</span>
            <span className="text-text-light-secondary dark:text-text-dark-secondary">Rain</span>
            <span className="font-semibold text-right">{fmt1(u.rain)} mm/h</span>
          </div>
        </div>
      )}
    </Card>
  );
};

export default EnvironmentalPanel;