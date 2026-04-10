
import React, { useState, useEffect } from 'react';
import { StationData, OperationalMode } from '../types';
import Card, { CardHeader, CardTitle } from './common/Card';
import Gauge from './Gauge';
import { stat } from 'fs';

interface StationPanelProps {
  station: StationData;
  setMode: (mode: OperationalMode) => void;
  sendManualCommand: (id: string, azimuth: number, elevation: number) => void;
  resetError: (id: string) => void;
}

const getStatusColor = (mode: OperationalMode, online: boolean, hasError: boolean) => {
  if (!online) return 'text-gray-400';
  if (hasError || mode === OperationalMode.ERROR) return 'text-accent-red';
  if (mode === OperationalMode.MAINT) return 'text-accent-yellow';
  return 'text-accent-green';
};

const getRssiColor = (rssi?: number) => {
  if (!rssi) return 'text-gray-400';
  if (rssi > -50) return 'text-accent-green';
  if (rssi > -65) return 'text-accent-yellow';
  return 'text-accent-red';
};

const StationPanel: React.FC<StationPanelProps> = ({ station, setMode, sendManualCommand, resetError }) => {
  // Local state for dragging sliders (Rule: update visually while dragging, don't API until release)
  

  const localStation = station !== undefined ? station : {
  station_id: "station_1",
  mode: "AUTO",

  connection: {
    last_heartbeat: "2026-01-16T15:10:41.019501",
    online: false
  },

  current_angles: {
    azimuth: 30,
    elevation: 30
  },

  target_angles: null,

  command: {
    pending: false,
    issued_at: null,
    acknowledged: false
  },

  error: {
    has_error: false,
    error_code: null,
    error_message: null,
    timestamp: null
  }
};
  const [localAz, setLocalAz] = useState(station !== undefined ? station.current_angles.azimuth : 30);
  const [localEl, setLocalEl] = useState(station !== undefined ? station.current_angles.elevation : 30);
  const [isDragging, setIsDragging] = useState(false);

  // Sync with backend when not dragging
  useEffect(() => {
    if (!isDragging) {
      setLocalAz(localStation.current_angles.azimuth);
      setLocalEl(localStation.current_angles.elevation);
    }
  }, [localStation.current_angles, isDragging]);

  const handleSliderChange = (e: React.ChangeEvent<HTMLInputElement>, type: 'azimuth' | 'elevation') => {
    if (type === 'azimuth') setLocalAz(parseFloat(e.target.value));
    else setLocalEl(parseFloat(e.target.value));
  };

  const handleRelease = () => {
    setIsDragging(false);
    sendManualCommand(localStation.station_id, localAz, localEl);
  };

  const rssi = localStation.telemetry?.rssi || -45;
  const rssiPercentage = ((rssi - -90) / (-30 - -90)) * 100;
  const isControlsDisabled = !localStation.connection.online || 
                             localStation.mode !== OperationalMode.MANUAL || 
                             localStation.command.pending || 
                             localStation.error.has_error;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{localStation.station_id.replace('_', ' ').toUpperCase()}</CardTitle>
        <div className="flex items-center space-x-4">
          <div className={`flex items-center text-sm font-bold ${getStatusColor(localStation.mode, localStation.connection.online, localStation.error.has_error)}`}>
            <span className={`w-2 h-2 rounded-full mr-2 ${getStatusColor(localStation.mode, localStation.connection.online, localStation.error.has_error).replace('text-', 'bg-')}`}></span>
            {localStation.connection.online ? localStation.mode : 'OFFLINE'}
          </div>
          <div className={`font-bold text-lg ${getRssiColor(rssi)}`}>
            {rssi.toFixed(1)} dBm
          </div>
        </div>
      </CardHeader>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Gauges */}
        <div className="col-span-1 md:col-span-2 grid grid-cols-2 gap-4">
          <div className="h-32">
            <Gauge label="Azimuth" value={localAz} max={170} unit="°" isCompass={true} />
          </div>
          <div className="h-32">
            <Gauge label="Elevation" value={localEl} max={170} unit="°" />
          </div>
        </div>

        {/* Sliders Area */}
        <div className="col-span-1 md:col-span-2 mt-2 space-y-3">
          <div className="w-full relative">
            <label className="text-xs font-semibold text-text-light-secondary dark:text-text-dark-secondary flex justify-between">
              Azimuth Adjust <span>{localAz.toFixed(1)}°</span>
            </label>
            <input
              type="range"
              min="0"
              max="180"
              step="0.1"
              disabled={isControlsDisabled}
              value={localAz}
              onMouseDown={() => setIsDragging(true)}
              onTouchStart={() => setIsDragging(true)}
              onChange={(e) => handleSliderChange(e, 'azimuth')}
              onMouseUp={handleRelease}
              onTouchEnd={handleRelease}
              className={`w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer dark:bg-gray-700 ${isControlsDisabled ? 'opacity-50 cursor-not-allowed' : ''}`}
            />
          </div>

          <div className="w-full relative">
            <label className="text-xs font-semibold text-text-light-secondary dark:text-text-dark-secondary flex justify-between">
              Elevation Adjust <span>{localEl.toFixed(1)}°</span>
            </label>
            <input
              type="range"
              min="0"
              max="180"
              step="0.1"
              disabled={isControlsDisabled}
              value={localEl}
              onMouseDown={() => setIsDragging(true)}
              onTouchStart={() => setIsDragging(true)}
              onChange={(e) => handleSliderChange(e, 'elevation')}
              onMouseUp={handleRelease}
              onTouchEnd={handleRelease}
              className={`w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer dark:bg-gray-700 ${isControlsDisabled ? 'opacity-50 cursor-not-allowed' : ''}`}
            />
          </div>

          {/* Pending State Banner */}
          {localStation.command.pending && (
            <div className="bg-blue-100 dark:bg-blue-900/30 text-blue-800 dark:text-blue-200 text-xs p-2 rounded flex items-center justify-between animate-pulse">
              <span>Command in-flight to target: {localStation.target_angles?.azimuth.toFixed(1)}°, {localStation.target_angles?.elevation.toFixed(1)}°</span>
              <div className="w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin"></div>
            </div>
          )}

          {/* Signal Indicator */}
          <div>
            <div className="w-full bg-gray-200 rounded-full h-1.5 dark:bg-gray-700 mt-2">
              <div
                className="bg-accent-blue h-1.5 rounded-full"
                style={{ width: `${rssiPercentage}%`, transition: 'width 0.5s ease' }}
              ></div>
            </div>
          </div>
        </div>

        {/* Mode & Error Controls */}
        <div className="col-span-1 md:col-span-2 space-y-2">
          {localStation.error.has_error && (
            <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 p-3 rounded-lg flex items-center justify-between">
              <div className="text-xs text-red-600 dark:text-red-400">
                <span className="font-bold">FAULT DETECTED:</span> {localStation.error.message || 'Mechanical failure'}
              </div>
              <button 
                onClick={() => resetError(localStation.station_id)}
                className="bg-red-600 hover:bg-red-700 text-white text-[10px] px-2 py-1 rounded font-bold transition-colors"
              >
                RESET
              </button>
            </div>
          )}

          <div className="bg-gray-50 dark:bg-gray-900/50 p-3 rounded-lg border border-gray-100 dark:border-gray-800">
            <h3 className="font-semibold mb-2 text-xs text-text-light-secondary dark:text-text-dark-secondary">
              Governance Protocol
            </h3>
            <div className="flex space-x-2">
              {[OperationalMode.AUTO, OperationalMode.MANUAL].map((m) => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  disabled={!localStation.connection.online || localStation.mode === OperationalMode.ERROR}
                  className={`flex-1 py-1 px-2 text-xs font-bold rounded-md transition-all ${
                    localStation.mode === m
                      ? 'bg-accent-blue text-white shadow-md scale-105'
                      : 'bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 disabled:opacity-30'
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
};

export default StationPanel;
