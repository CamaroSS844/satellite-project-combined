
export enum OperationalMode {
  AUTO = 'AUTO',
  MANUAL = 'MANUAL',
  MAINT = 'MAINT',
  ERROR = 'ERROR',
}

export enum SystemStatus {
  OK = 'OK',
  MAINTENANCE = 'Maintenance',
  ERROR = 'Error',
}

export enum Severity {
  INFO = 'Info',
  WARN = 'Warning',
  CRIT = 'Critical',
}

export interface EnvironmentalData {
  temperature: number;
  humidity: number;
  windSpeed: number;
  pressure: number;
  rainRate: number;
  rssi?: number;
}

export interface StationData {
  station_id: string;
  mode: OperationalMode;
  connection: {
    online: boolean;
    last_heartbeat: string;
  };
  current_angles: {
    azimuth: number;
    elevation: number;
  };
  target_angles: {
    azimuth: number;
    elevation: number;
  } | null;
  command: {
    pending: boolean;
    acknowledged: boolean;
  };
  error: {
    has_error: boolean;
    message?: string;
  };
  // Optional telemetry if provided by backend, otherwise simulated for UI richness
  telemetry?: EnvironmentalData;
}

export interface Alert {
  id: number;
  timestamp: string;
  severity: Severity;
  message: string;
}

export interface KPIs {
  avgSignalQuality: number;
  realignmentsPerHour: number;
  downtimeReduction: number;
  powerUsage: number;
}

export interface TrendDataPoint {
  time: string;
  rssi_A: number;
  rssi_B: number;
  windSpeed_A: number;
  windSpeed_B: number;
}
