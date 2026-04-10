
import React, { useState, useRef, MouseEvent, useEffect } from 'react';
import Card, { CardHeader, CardTitle } from './common/Card';

interface ManualControlPanelProps {
    onMove: (dx: number, dy: number) => void;
    onCommand: (command: string) => void;
}

const ManualControlPanel: React.FC<ManualControlPanelProps> = ({ onMove, onCommand }) => {
  const [command, setCommand] = useState('');
  const [displacement, setDisplacement] = useState({ x: 0, y: 0 });
  const joystickRef = useRef<HTMLDivElement>(null);
  const knobRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  
  const handleJoystickMove = (e: any) => {
    if (!isDragging || !joystickRef.current || !knobRef.current) return;
    
    // Support touch and mouse
    const clientX = e.clientX || (e.touches && e.touches[0].clientX);
    const clientY = e.clientY || (e.touches && e.touches[0].clientY);
    
    const rect = joystickRef.current.getBoundingClientRect();
    const size = rect.width;
    const halfSize = size / 2;
    
    let x = clientX - rect.left - halfSize;
    let y = clientY - rect.top - halfSize;
    
    const distance = Math.sqrt(x*x + y*y);
    const maxDistance = halfSize - knobRef.current.offsetWidth / 2;

    if (distance > maxDistance) {
        x = (x / distance) * maxDistance;
        y = (y / distance) * maxDistance;
    }

    knobRef.current.style.transform = `translate(${x}px, ${y}px)`;

    const dx = x / maxDistance;
    const dy = -y / maxDistance; // Invert Y-axis
    
    setDisplacement({ x: dx, y: dy });
    onMove(dx * 0.5, dy * 0.5); // Scaled for fine control as per previous logic
  };
  
  const handleEnd = () => {
    setIsDragging(false);
    setDisplacement({ x: 0, y: 0 });
    if (knobRef.current) {
        knobRef.current.style.transform = 'translate(0px, 0px)';
    }
  };

  useEffect(() => {
    if (isDragging) {
      window.addEventListener('mousemove', handleJoystickMove);
      window.addEventListener('mouseup', handleEnd);
      window.addEventListener('touchmove', handleJoystickMove, { passive: false });
      window.addEventListener('touchend', handleEnd);
    } else {
      window.removeEventListener('mousemove', handleJoystickMove);
      window.removeEventListener('mouseup', handleEnd);
      window.removeEventListener('touchmove', handleJoystickMove);
      window.removeEventListener('touchend', handleEnd);
    }
    return () => {
      window.removeEventListener('mousemove', handleJoystickMove);
      window.removeEventListener('mouseup', handleEnd);
      window.removeEventListener('touchmove', handleJoystickMove);
      window.removeEventListener('touchend', handleEnd);
    };
  }, [isDragging]);

  const handleMouseDown = (e: MouseEvent<HTMLDivElement>) => {
    setIsDragging(true);
  };

  const handleCommandSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (command.trim()) {
        onCommand(command);
        setCommand('');
    }
  };

  // Calculate dynamic styles for the knob
  const intensity = Math.sqrt(displacement.x ** 2 + displacement.y ** 2);
  const knobScale = isDragging ? 1.1 + intensity * 0.1 : 1.0;
  
  // Shift from blue towards a brighter cyan/white glow based on intensity
  const knobColor = isDragging 
    ? `rgb(${59 + intensity * 50}, ${130 + intensity * 100}, ${246 + intensity * 9})` 
    : 'var(--accent-blue)';

  return (
    <Card>
      <CardHeader>
        <CardTitle>Manual Override</CardTitle>
      </CardHeader>
      <div className="space-y-4">
        <div>
          <div className="flex justify-between items-center mb-2">
            <h3 className="font-semibold text-sm text-text-light-secondary dark:text-text-dark-secondary">
              Directional Control
            </h3>
            <div className="text-[10px] font-mono bg-gray-100 dark:bg-gray-800 px-2 py-0.5 rounded text-accent-blue border border-gray-200 dark:border-gray-700">
              ΔX: {displacement.x.toFixed(2)} ΔY: {displacement.y.toFixed(2)}
            </div>
          </div>
          
          <div className="flex justify-center items-center py-4">
            <div 
              ref={joystickRef}
              className="w-32 h-32 sm:w-40 sm:h-40 bg-gray-200 dark:bg-gray-800 rounded-full flex items-center justify-center relative select-none shadow-inner border-4 border-gray-300 dark:border-gray-700"
              onMouseDown={handleMouseDown}
              onTouchStart={() => setIsDragging(true)}
            >
              {/* Reference Grid */}
              <div className="absolute w-full h-[1px] bg-gray-300 dark:bg-gray-700 opacity-50"></div>
              <div className="absolute h-full w-[1px] bg-gray-300 dark:bg-gray-700 opacity-50"></div>
              
              <div 
                ref={knobRef} 
                style={{
                  transition: !isDragging ? 'transform 0.2s cubic-bezier(0.175, 0.885, 0.32, 1.275), background-color 0.2s' : 'none',
                  backgroundColor: knobColor,
                  transform: isDragging ? undefined : 'translate(0px, 0px)',
                  scale: knobScale.toString(),
                  boxShadow: isDragging ? `0 0 ${10 + intensity * 20}px ${knobColor}` : '0 4px 6px -1px rgb(0 0 0 / 0.1)'
                }} 
                className="w-12 h-12 sm:w-14 sm:h-14 rounded-full cursor-grab active:cursor-grabbing z-10 flex items-center justify-center border-2 border-white/20"
              >
                {/* Knob details */}
                <div className="w-6 h-6 border-2 border-white/10 rounded-full"></div>
              </div>
            </div>
          </div>
        </div>

        <div>
           <h3 className="font-semibold mb-2 text-sm text-text-light-secondary dark:text-text-dark-secondary">Command Terminal</h3>
           <form onSubmit={handleCommandSubmit} className="flex space-x-2">
                <input 
                    type="text" 
                    value={command}
                    onChange={(e) => setCommand(e.target.value)}
                    placeholder="e.g., diag --run all"
                    className="flex-grow bg-gray-100 dark:bg-gray-900 text-sm p-2 rounded-md border border-gray-300 dark:border-gray-600 focus:ring-2 focus:ring-accent-blue focus:outline-none transition-all"
                />
                <button 
                  type="submit" 
                  className="bg-accent-blue text-white font-bold px-4 rounded hover:bg-blue-700 active:scale-95 transition-all text-sm shadow-md"
                >
                  Send
                </button>
           </form>
        </div>
      </div>
    </Card>
  );
};

export default ManualControlPanel;
