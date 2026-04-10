
import React from 'react';
import { Icon } from './common/Icon';

interface HeaderProps {
  theme: 'light' | 'dark';
  toggleTheme: () => void;
}

const Header: React.FC<HeaderProps> = ({ theme, toggleTheme }) => {
  return (
    <header className="flex justify-between items-center">
      <div>
        <h1 className="text-2xl font-bold text-accent-blue">Intelligent Microwave Alignment Dashboard</h1>
        <p className="text-sm text-text-light-secondary dark:text-text-dark-secondary">Real-time Monitoring & Control System</p>
      </div>
      <button
        onClick={toggleTheme}
        className="p-2 rounded-full bg-card-light dark:bg-card-dark shadow-md hover:bg-gray-100 dark:hover:bg-gray-600 transition-colors"
        aria-label="Toggle theme"
      >
        <Icon name={theme === 'light' ? 'moon' : 'sun'} className="w-6 h-6 text-accent-orange" />
      </button>
    </header>
  );
};

export default Header;
