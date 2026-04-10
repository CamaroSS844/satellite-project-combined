
import React, { ReactNode } from 'react';

interface CardProps {
  children: ReactNode;
  className?: string;
}

const Card: React.FC<CardProps> = ({ children, className = '' }) => {
  return (
    <div className={`bg-card-light dark:bg-card-dark p-4 rounded-lg shadow-md border border-gray-200 dark:border-gray-700 ${className}`}>
      {children}
    </div>
  );
};

export const CardHeader: React.FC<{ children: ReactNode; className?: string }> = ({ children, className }) => (
    <div className={`flex items-center justify-between pb-3 mb-3 border-b border-gray-200 dark:border-gray-600 ${className}`}>
        {children}
    </div>
);

export const CardTitle: React.FC<{ children: ReactNode }> = ({ children }) => (
    <h2 className="text-lg font-semibold text-text-light-primary dark:text-text-dark-primary">{children}</h2>
);


export default Card;
