interface TickerProps {
  flags: string[];
  randomEvent?: string | null;
}

/**
 * Ticker component to display spin rule flags and random events
 */
export const Ticker = ({ flags, randomEvent }: TickerProps) => {
  if (flags.length === 0 && !randomEvent) {
    return null;
  }

  return (
    <div className="text-sm italic text-gray-500 mt-2">
      {flags.length > 0 && (
        <span>Flags: {flags.join(', ')}</span>
      )}
      {randomEvent && (
        <span className="ml-2 text-purple-600">✨ {randomEvent}</span>
      )}
    </div>
  );
};
