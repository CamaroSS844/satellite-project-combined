
import React from 'react';

interface IconProps {
  name: string;
  className?: string;
}

export const Icon: React.FC<IconProps> = ({ name, className = 'w-6 h-6' }) => {
  const icons: { [key: string]: React.ReactNode } = {
    sun: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />,
    moon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />,
    temperature: <path strokeLinecap="round" strokeLinejoin="round" d="M14.25 8.042a3.375 3.375 0 0 0-3.375-3.375V1.5a.75.75 0 0 0-1.5 0v3.167A3.375 3.375 0 0 0 6 8.042a4.875 4.875 0 0 0 4.875 4.875A4.875 4.875 0 0 0 14.25 8.042Zm-4.875 3.375a3.375 3.375 0 0 1-3.375-3.375h1.5a1.875 1.875 0 1 0 3.75 0h1.5a3.375 3.375 0 0 1-3.375 3.375Z" />,
    wind: <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 12h16.5m-16.5 3.75h16.5M3.75 15.75h16.5M3.75 8.25h16.5M3.75 5.25h16.5" />,
    humidity: <path strokeLinecap="round" strokeLinejoin="round" d="M12.75 3.75A2.25 2.25 0 0 0 10.5 6v7.5a2.25 2.25 0 1 0 4.5 0V6A2.25 2.25 0 0 0 12.75 3.75Z" />,
    rain: <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m-3.75-6.75 3.75 3.75 3.75-3.75" />,
    pressure: <path strokeLinecap="round" strokeLinejoin="round" d="M3 12h1.5M19.5 12H21m-16.5 4.5L6 18m12-1.5-1.5-1.5M12 3v1.5m0 15V21m-4.5-16.5L6 6m12 1.5 1.5-1.5M12 6a6 6 0 1 0 0 12 6 6 0 0 0 0-12Z" />,
    lightbulb: <path strokeLinecap="round" strokeLinejoin="round" d="M12 18v-5.25m0 0a3 3 0 0 0-3-3m3 3a3 3 0 0 1 3-3m-3 3V9M6.75 12H9m6 0h2.25M12 6V5.25m-3.75 2.25L7.5 6.75M16.5 7.5l-1.5-1.5m-3.75 10.5a7.5 7.5 0 1 1-15 0 7.5 7.5 0 0 1 15 0Z" />,
    arrow: <path strokeLinecap="round" strokeLinejoin="round" d="m15 15-6 6m0 0-6-6m6 6V9a6 6 0 0 1 12 0v3" />,
  };

  return (
    <svg xmlns="http://www.w3.org/2000/svg" className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      {icons[name]}
    </svg>
  );
};
