
import React from 'react';
import Card, { CardHeader, CardTitle } from './common/Card';
import { Icon } from './common/Icon';

interface SystemOverviewPanelProps {
  backendStatus: 'Connected' | 'Simulating';
  statusLog: string[];
}

const SystemOverviewPanel: React.FC<SystemOverviewPanelProps> = ({ backendStatus, statusLog }) => {
  return (
    <Card className="flex flex-col h-full">
      <CardHeader>
        <CardTitle>System Overview</CardTitle>
        <div className={`flex items-center text-sm ${backendStatus === 'Connected' ? 'text-accent-green' : 'text-accent-yellow'}`}>
          <span className={`w-2 h-2 rounded-full mr-2 ${backendStatus === 'Connected' ? 'bg-accent-green' : 'bg-accent-yellow'}`}></span>
          {backendStatus}
        </div>
      </CardHeader>

      <div className="space-y-4">
        <div>
          <h3 className="font-semibold mb-2 text-text-light-secondary dark:text-text-dark-secondary">Data Flow</h3>
          <div className="flex items-center justify-between text-xs text-center">
            <div className="flex flex-col items-center">
              <div className="p-2 bg-blue-100 dark:bg-blue-900 rounded-full"><Icon name="arrow" className="w-5 h-5 text-blue-500" /></div>
              <span>ESP32</span>
            </div>
            <span className="text-gray-400">→</span>
             <div className="flex flex-col items-center">
              <div className="p-2 bg-blue-100 dark:bg-blue-900 rounded-full"><Icon name="arrow" className="w-5 h-5 text-blue-500" /></div>
              <span>MQTT</span>
            </div>
            <span className="text-gray-400">→</span>
             <div className="flex flex-col items-center">
              <div className="p-2 bg-blue-100 dark:bg-blue-900 rounded-full"><Icon name="arrow" className="w-5 h-5 text-blue-500" /></div>
              <span>FastAPI</span>
            </div>
            <span className="text-gray-400">→</span>
             <div className="flex flex-col items-center">
              <div className="p-2 bg-green-100 dark:bg-green-900 rounded-full"><Icon name="arrow" className="w-5 h-5 text-green-500 transform rotate-90" /></div>
              <span className="font-bold">Dashboard</span>
            </div>
          </div>
        </div>

        <div>
          <h3 className="font-semibold mb-2 text-text-light-secondary dark:text-text-dark-secondary">Backend Status Log</h3>
          <div className="bg-gray-100 dark:bg-gray-900 p-2 rounded-md h-48 overflow-y-auto font-mono text-xs">
            {statusLog.map((log, index) => (
              <p key={index} className="whitespace-pre-wrap">{log}</p>
            ))}
          </div>
        </div>
        
        <div className="flex items-center text-sm text-text-light-secondary dark:text-text-dark-secondary">
          <input type="checkbox" checked={true} readOnly className="form-checkbox h-4 w-4 text-accent-green rounded mr-2" />
          <span>Redundancy: Station B is Online</span>
        </div>
        
        <button className="w-full bg-accent-red text-white font-bold py-2 px-4 rounded hover:bg-red-700 transition-colors">
          EMERGENCY STOP
        </button>

      </div>
    </Card>
  );
};

export default SystemOverviewPanel;
