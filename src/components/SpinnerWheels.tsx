import { useEffect, useState } from 'react';
import type { Region, Taxon, IUCN } from '../types';

interface RingProps {
  items: string[];
  currentIndex: number;
  spinning: boolean;
  label: string;
  color: string;
}

const Ring = ({ items, currentIndex, spinning, label, color }: RingProps) => {
  return (
    <div className={`flex flex-col items-center ${spinning ? 'animate-pulse' : ''}`}>
      <div className={`text-sm font-semibold mb-2 ${color}`}>{label}</div>
      <div className="relative w-48 h-48 border-4 rounded-full flex items-center justify-center bg-white shadow-lg" style={{ borderColor: color.replace('text-', '') }}>
        <div className="text-center">
          <div className="text-2xl font-bold">{items[currentIndex]}</div>
        </div>
        {spinning && (
          <div className="absolute inset-0 rounded-full border-4 border-transparent border-t-current animate-spin" style={{ borderColor: `transparent ${color.replace('text-', '')} transparent transparent` }}></div>
        )}
      </div>
    </div>
  );
};

interface SpinnerWheelsProps {
  region: Region;
  taxon: Taxon;
  iucn: IUCN;
  spinning: boolean;
  regionItems: Region[];
  taxonItems: Taxon[];
  iucnItems: IUCN[];
}

export const SpinnerWheels = ({
  region,
  taxon,
  iucn,
  spinning,
  regionItems,
  taxonItems,
  iucnItems,
}: SpinnerWheelsProps) => {
  const [regionIndex, setRegionIndex] = useState(0);
  const [taxonIndex, setTaxonIndex] = useState(0);
  const [iucnIndex, setIucnIndex] = useState(0);

  useEffect(() => {
    if (!spinning) {
      setRegionIndex(regionItems.indexOf(region));
      setTaxonIndex(taxonItems.indexOf(taxon));
      setIucnIndex(iucnItems.indexOf(iucn));
    }
  }, [spinning, region, taxon, iucn, regionItems, taxonItems, iucnItems]);

  useEffect(() => {
    if (!spinning) return;

    const interval = setInterval(() => {
      setRegionIndex(prev => (prev + 1) % regionItems.length);
      setTaxonIndex(prev => (prev + 1) % taxonItems.length);
      setIucnIndex(prev => (prev + 1) % iucnItems.length);
    }, 100);

    return () => clearInterval(interval);
  }, [spinning, regionItems.length, taxonItems.length, iucnItems.length]);

  return (
    <div className="flex flex-wrap justify-center gap-8 my-8">
      <Ring
        items={regionItems}
        currentIndex={regionIndex}
        spinning={spinning}
        label="Region"
        color="text-blue-600"
      />
      <Ring
        items={taxonItems}
        currentIndex={taxonIndex}
        spinning={spinning}
        label="Taxon"
        color="text-green-600"
      />
      <Ring
        items={iucnItems}
        currentIndex={iucnIndex}
        spinning={spinning}
        label="IUCN Status"
        color="text-red-600"
      />
    </div>
  );
};
