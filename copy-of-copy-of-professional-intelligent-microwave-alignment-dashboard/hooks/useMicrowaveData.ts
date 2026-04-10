
import { useState, useEffect, useCallback, useRef } from 'react';
import { StationData, KPIs, Alert, TrendDataPoint, Severity, OperationalMode } from '../types';
import { INITIAL_KPIS, INITIAL_ALERTS } from '../constants';

const POLLING_INTERVAL = 1500;
const API_BASE = 'http://localhost:8000';

export const useMicrowaveData = () => {
  const [stations, setStations] = useState<StationData[]>([]);
  const [kpis, setKpis] = useState<KPIs>(INITIAL_KPIS);
  const [alerts, setAlerts] = useState<Alert[]>(INITIAL_ALERTS);
  const [trendData, setTrendData] = useState<TrendDataPoint[]>([]);
  const [backendStatus, setBackendStatus] = useState<'Connected' | 'Simulating'>('Simulating');
  const [statusLog, setStatusLog] = useState<string[]>(['[INFO] System startup...']);
  const [aiInsight, setAiInsight] = useState<string>("System nominal. Monitoring polling loop.");

  const logRef = useRef(statusLog);
  const updateLog = (msg: string) => {
    const timestamp = new Date().toLocaleTimeString();
    const formatted = `[${timestamp}] ${msg}`;
    console.log(formatted);
    setStatusLog(prev => [formatted, ...prev].slice(0, 50));
  };

  const pollStations = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE}/dashboard/stations`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data: StationData[] = await response.json();
      
      setStations(data);
      setBackendStatus('Connected');
      
      // Update Trends logic using first two stations if available
      if (data.length >= 2) {
        setTrendData(prev => {
          const now = new Date();
          const newPoint = {
            time: `${now.getHours()}:${now.getMinutes()}:${now.getSeconds()}`,
            rssi_A: data[0].telemetry?.rssi || -45,
            rssi_B: data[1].telemetry?.rssi || -47,
            windSpeed_A: data[0].telemetry?.windSpeed || 10,
            windSpeed_B: data[1].telemetry?.windSpeed || 12,
          };
          return [...prev, newPoint].slice(-30);
        });
      }
    } catch (e) {
      if (backendStatus === 'Connected') {
        updateLog('ERROR: Backend polling failed. Reverting to simulation.');
        setBackendStatus('Simulating');
      }
      // Simulation fallback if API not present
      simulateData();
    }
  }, [backendStatus]);

  const simulateData = () => {
    setStations(prev => {
      if (prev.length === 0) {
        return [
          {
            station_id: 'station_1',
            mode: OperationalMode.AUTO,
            connection: { online: true, last_heartbeat: new Date().toISOString() },
            current_angles: { azimuth: 178.5, elevation: 22.3 },
            target_angles: null,
            command: { pending: false, acknowledged: false },
            error: { has_error: false },
            telemetry: { temperature: 25, humidity: 60, windSpeed: 10, pressure: 1012, rainRate: 0, rssi: -45 }
          },
          {
            station_id: 'station_2',
            mode: OperationalMode.AUTO,
            connection: { online: true, last_heartbeat: new Date().toISOString() },
            current_angles: { azimuth: 358.5, elevation: 22.3 },
            target_angles: null,
            command: { pending: false, acknowledged: false },
            error: { has_error: false },
            telemetry: { temperature: 24, humidity: 62, windSpeed: 12, pressure: 1012, rainRate: 0, rssi: -48 }
          }
        ];
      }
      return prev.map(s => ({
        ...s,
        current_angles: {
          azimuth: s.current_angles.azimuth + (Math.random() - 0.5) * 0.05,
          elevation: s.current_angles.elevation + (Math.random() - 0.5) * 0.02,
        },
        telemetry: s.telemetry ? {
          ...s.telemetry,
          rssi: Math.max(-90, Math.min(-30, s.telemetry.rssi! + (Math.random() - 0.5) * 0.2)),
          windSpeed: Math.max(0, s.telemetry.windSpeed + (Math.random() - 0.5) * 0.5)
        } : undefined
      }));
    });
  };

  useEffect(() => {
    const timer = setInterval(pollStations, POLLING_INTERVAL);
    return () => clearInterval(timer);
  }, [pollStations]);

  const setStationMode = async (id: string, mode: OperationalMode) => {
    updateLog(`UI: Requesting mode change for ${id} to ${mode}`);
    try {
      const response = await fetch(`${API_BASE}/dashboard/mode/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode })
      });
      if (!response.ok) throw new Error();
      updateLog(`API: Mode change confirmed for ${id}`);
    } catch (e) {
      updateLog(`SIM: Simulating mode change for ${id} to ${mode}`);
      setStations(prev => prev.map(s => s.station_id === id ? { ...s, mode } : s));
    }
  };

  const sendManualCommand = async (id: string, azimuth: number, elevation: number) => {
    updateLog(`UI: Dispatching manual command to ${id} -> AZ:${azimuth.toFixed(1)} EL:${elevation.toFixed(1)}`);
    
    // Optimistic UI disable
    // setStations(prev => prev.map(s => s.station_id === id ? { 
    //   ...s, 
    //   command: { ...s.command, pending: true },
    //   target_angles: { azimuth, elevation }
    // } : s));

    try {
      const response = await fetch(`${API_BASE}/dashboard/manual/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ azimuth, elevation })
      });
      if (!response.ok) throw new Error();
      updateLog(`API: Manual command accepted for ${id}`);
    } catch (e) {
      updateLog(`SIM: Simulating command execution for ${id}. Clearing pending in 3s.`);
      setTimeout(() => {
        setStations(prev => prev.map(s => s.station_id === id ? { 
          ...s, 
          command: { ...s.command, pending: false },
          target_angles: null,
          current_angles: { azimuth, elevation }
        } : s));
      }, 3000);
    }
  };

  const resetError = async (id: string) => {
    updateLog(`UI: Resetting error state for ${id}`);
    try {
      await fetch(`${API_BASE}/dashboard/reset_error/${id}`, { method: 'POST' });
    } catch (e) {
      updateLog(`SIM: Error cleared for ${id}. Switching to MAINT.`);
      setStations(prev => prev.map(s => s.station_id === id ? { ...s, mode: OperationalMode.MAINT, error: { has_error: false } } : s));
    }
  };

  const addAlert = useCallback((severity: Severity, message: string) => {
    setAlerts(prev => [{ id: Date.now(), timestamp: new Date().toLocaleTimeString(), severity, message }, ...prev].slice(0, 100));
    updateLog(`ALERT: [${severity}] ${message}`);
  }, []);

  return { stations, kpis, alerts, trendData, backendStatus, statusLog, aiInsight, setStationMode, sendManualCommand, resetError, addAlert };
};
