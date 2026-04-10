
import React from 'react';

interface GaugeProps {
  label: string;
  value: number;
  max: number;
  unit: string;
  isCompass?: boolean;
}

const Gauge: React.FC<GaugeProps> = ({ label, value, max, unit, isCompass = false }) => {
  const percentage = value / max;
  const rotation = isCompass ? value : -135 + (percentage * 270);
  const circumference = 2 * Math.PI * 40;
  const strokeDashoffset = circumference - (percentage * circumference * 0.75); // 0.75 for 270 degrees

  return (
    <div className="flex flex-col items-center justify-center relative w-full h-full">
      <svg viewBox="0 0 100 100" className="w-full h-full transform -rotate-90">
        {/* Compass Rose Background */}
        {isCompass && (
          <g transform="rotate(90 50 50)">
            <text x="50" y="10" textAnchor="middle" fontSize="8" fill="currentColor" className="text-text-light-secondary dark:text-text-dark-secondary">N</text>
            <text x="50" y="94" textAnchor="middle" fontSize="8" fill="currentColor" className="text-text-light-secondary dark:text-text-dark-secondary">S</text>
            <text x="10" y="54" textAnchor="middle" fontSize="8" fill="currentColor" className="text-text-light-secondary dark:text-text-dark-secondary">W</text>
            <text x="90" y="54" textAnchor="middle" fontSize="8" fill="currentColor" className="text-text-light-secondary dark:text-text-dark-secondary">E</text>
            <line x1="50" y1="12" x2="50" y2="18" stroke="currentColor" strokeWidth="1" className="text-gray-300 dark:text-gray-600"/>
            <line x1="50" y1="88" x2="50" y2="82" stroke="currentColor" strokeWidth="1" className="text-gray-300 dark:text-gray-600"/>
            <line x1="12" y1="50" x2="18" y2="50" stroke="currentColor" strokeWidth="1" className="text-gray-300 dark:text-gray-600"/>
            <line x1="88" y1="50" x2="82" y2="50" stroke="currentColor" strokeWidth="1" className="text-gray-300 dark:text-gray-600"/>
          </g>
        )}
        
        {/* Gauge Track */}
        <circle cx="50" cy="50" r="40" strokeWidth="8" stroke="currentColor" fill="transparent"
          className="text-gray-200 dark:text-gray-700"
          strokeDasharray={circumference}
          strokeDashoffset={circumference - (circumference * 0.75)}
          transform="rotate(-135 50 50)"
        />
        
        {/* Gauge Value */}
        <circle cx="50" cy="50" r="40" strokeWidth="8" stroke="currentColor" fill="transparent"
          className="text-accent-blue"
          strokeDasharray={circumference}
          strokeDashoffset={strokeDashoffset}
          transform="rotate(-135 50 50)"
          style={{ transition: 'stroke-dashoffset 0.5s ease' }}
        />
        
        {/* Needle for Compass */}
        {isCompass && (
  <g transform={`rotate(${rotation} 50 50)`}>
    {/* Red tip */}
    <polygon points="50,20 53,48 50,45 47,48" className="fill-current text-accent-red" />
    {/* Gray tail */}
    <polygon points="50,80 53,52 50,55 47,52" className="fill-current text-gray-400" />
  </g>
)}

      </svg>
      <div className="absolute flex flex-col items-center">
       <span className="text-l font-bold text-text-light-primary dark:text-text-dark-primary">
  {value.toFixed(1)}
  <span className="text-sm font-normal ml-1">{unit}</span>
</span>
<span className="text-xs text-text-light-secondary dark:text-text-dark-secondary mt-2">{label}</span>
</div>
    </div>
  );
};

export default Gauge;
