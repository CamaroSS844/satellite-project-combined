
import React from 'react';
import Card, { CardHeader, CardTitle } from './common/Card';
import { KPIs } from '../types';

interface KpiPanelProps {
  kpis: KPIs;
}

const KpiCard: React.FC<{ title: string; value: string; unit: string }> = ({ title, value, unit }) => (
  <div className="p-2 bg-gray-50 dark:bg-gray-700/50 rounded-md">
    <p className="text-xs text-text-light-secondary dark:text-text-dark-secondary">{title}</p>
    <p className="text-xl font-bold text-text-light-primary dark:text-text-dark-primary">
      {value} <span className="text-sm font-normal">{unit}</span>
    </p>
  </div>
);

const KpiPanel: React.FC<KpiPanelProps> = ({ kpis }) => {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Key Performance Indicators</CardTitle>
      </CardHeader>
      <div className="grid grid-cols-2 gap-3">
        <KpiCard title="Avg. Signal Quality" value={kpis.avgSignalQuality.toFixed(1)} unit="%" />
        <KpiCard title="Realignments / hr" value={kpis.realignmentsPerHour.toFixed(1)} unit="" />
        <KpiCard title="Downtime Reduction" value={kpis.downtimeReduction.toFixed(2)} unit="%" />
        <KpiCard title="Power Usage" value={kpis.powerUsage.toFixed(2)} unit="kWh" />
      </div>
    </Card>
  );
};

export default KpiPanel;
