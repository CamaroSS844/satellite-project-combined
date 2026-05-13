
import React from 'react';
import { useMicrowaveData } from './hooks/useMicrowaveData';
import Header from './components/Header';
import StationPanel from './components/StationPanel';
import SystemOverviewPanel from './components/SystemOverviewPanel';
import EnvironmentalPanel from './components/EnvironmentalPanel';
import TrendsPanel from './components/TrendsPanel';
import AlertsPanel from './components/AlertsPanel';
import KpiPanel from './components/KpiPanel';
import { useTheme } from './hooks/useTheme';
import BeamAlignmentPanel from './components/Beamalignmentpanel';
import PolarRadiationPanel from './components/Polarradiationpanel';
import { OperationalMode } from './types';
import SignalHistoryChart from './components/SignalHistoryChart';

const App: React.FC = () => {
  const [theme, toggleTheme] = useTheme();
  const { 
    stations,
    kpis, 
    alerts, 
    trendData, 
    backendStatus, 
    statusLog, 
    aiInsight,
    setStationMode,
    sendManualCommand,
    resetError
  } = useMicrowaveData();

  
  const station_names = ["station_1", "station_2"]; // Example station names
  if (stations.length === 0) {
    return <div>Loading stations...</div>;
  }
  
  

  return (
    <div className={`min-h-screen text-text-light-primary dark:text-text-dark-primary p-4 transition-colors duration-300`}>
      <Header theme={theme} toggleTheme={toggleTheme} />
      <main className="grid grid-cols-12 gap-4 mt-4">
        {/* Top Row: Authoritative Stations */}
        {station_names.map(s => (
          <div key={s} className="col-span-12 lg:col-span-6">
            <StationPanel 
              station={stations[s]} 
              setMode={(mode) => setStationMode(s, mode)} 
              sendManualCommand={sendManualCommand}
              resetError={resetError}
            />
          </div>
          
        ))}
        

        <div className="col-span-12 lg:col-span-12 space-y-4">
          {/* Environmental panel mapping updated to support multiple stations if available */}
          <EnvironmentalPanel stationA={stations[0] || {} as any} stationB={stations[1] || {} as any} />
          <KpiPanel kpis={kpis} />
        </div>


        {/* Second Row: Monitoring Content */}
        
        <div className="col-span-12 lg:col-span-6 space-y-4">
           {/* <SystemOverviewPanel backendStatus={backendStatus} statusLog={statusLog} /> */}
           <BeamAlignmentPanel />
        </div>

        <div className="col-span-12 lg:col-span-6 space-y-4">
          <PolarRadiationPanel stationLabel={stations[0]?.name || 'Station 1'} pattern={stations[0]?.radiationPattern || []} />
        </div>

        <div className="col-span-12 lg:col-span-6 space-y-4">
          <AlertsPanel alerts={alerts} />
          {/* <TrendsPanel data={trendData} aiInsight={aiInsight} /> */}
        </div>
      </main>
    </div>
  );
};

export default App;
