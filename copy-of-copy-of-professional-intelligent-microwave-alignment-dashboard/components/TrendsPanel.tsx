import React from 'react';
import Card, { CardHeader, CardTitle } from './common/Card';
import { TrendDataPoint } from '../types';
import { Icon } from './common/Icon';

interface TrendsPanelProps {
  data: TrendDataPoint[];
  aiInsight: string;
}

const TrendsPanel: React.FC<TrendsPanelProps> = ({ data, aiInsight }) => {
  const Recharts = (window as any).Recharts;

  if (!Recharts) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Trends & Analytics</CardTitle>
        </CardHeader>
        <div className="h-64 flex items-center justify-center text-text-light-secondary dark:text-text-dark-secondary">
          <p>Loading chart...</p>
        </div>
        <div className="mt-4 p-3 bg-blue-50 dark:bg-blue-900/50 rounded-lg flex items-start space-x-3">
            <Icon name="lightbulb" className="w-5 h-5 text-accent-blue flex-shrink-0 mt-1" />
            <div>
              <h4 className="font-semibold text-accent-blue">Predictive Insight</h4>
              <p className="text-sm text-text-light-secondary dark:text-text-dark-secondary">{aiInsight}</p>
            </div>
        </div>
      </Card>
    );
  }

  const { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } = Recharts;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Trends & Analytics</CardTitle>
      </CardHeader>
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 5, right: 20, left: -10, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(128, 128, 128, 0.2)" />
            <XAxis dataKey="time" tick={{ fontSize: 10, fill: 'currentColor' }} className="text-text-light-secondary dark:text-text-dark-secondary" />
            <YAxis yAxisId="left" label={{ value: 'RSSI (dBm)', angle: -90, position: 'insideLeft', fontSize: 12, fill: 'currentColor' }} tick={{ fontSize: 10, fill: 'currentColor' }} className="text-text-light-secondary dark:text-text-dark-secondary" />
            <YAxis yAxisId="right" orientation="right" label={{ value: 'Wind (km/h)', angle: 90, position: 'insideRight', fontSize: 12, fill: 'currentColor' }} tick={{ fontSize: 10, fill: 'currentColor' }} className="text-text-light-secondary dark:text-text-dark-secondary" />
            <Tooltip
              contentStyle={{
                backgroundColor: 'rgba(45, 55, 72, 0.8)', // bg-card-dark with opacity
                border: '1px solid #4A5568',
                color: '#E2E8F0', // text-dark-primary
                borderRadius: '0.5rem'
              }}
              itemStyle={{ color: '#E2E8F0' }}
              labelStyle={{ color: '#A0AEC0', fontWeight: 'bold' }}
            />
            <Legend wrapperStyle={{fontSize: "12px"}}/>
            <Line yAxisId="left" type="monotone" dataKey="rssi_A" name="RSSI A" stroke="#3b82f6" strokeWidth={2} dot={false} />
            <Line yAxisId="left" type="monotone" dataKey="rssi_B" name="RSSI B" stroke="#84a9f7" strokeWidth={2} dot={false} />
            <Line yAxisId="right" type="monotone" dataKey="windSpeed_A" name="Wind A" stroke="#f97316" strokeWidth={1} dot={false} strokeDasharray="5 5" />
            <Line yAxisId="right" type="monotone" dataKey="windSpeed_B" name="Wind B" stroke="#fca5a5" strokeWidth={1} dot={false} strokeDasharray="5 5" />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-4 p-3 bg-blue-50 dark:bg-blue-900/50 rounded-lg flex items-start space-x-3">
        <Icon name="lightbulb" className="w-5 h-5 text-accent-blue flex-shrink-0 mt-1" />
        <div>
          <h4 className="font-semibold text-accent-blue">Predictive Insight</h4>
          <p className="text-sm text-text-light-secondary dark:text-text-dark-secondary">{aiInsight}</p>
        </div>
      </div>
    </Card>
  );
};

export default TrendsPanel;
