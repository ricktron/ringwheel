import { useEffect, useState } from 'react';
import type { Region, Taxon, IUCN } from '../types';

interface RingProps {
  items: string[];
  currentIndex: number;
  spinning: boolean;
  label: string;
  color: string;
  onClick?: () => void;
  isSelected?: boolean;
}

const Ring = ({ items, currentIndex, spinning, label, color, onClick, isSelected }: RingProps) => {
  return (
    <div 
      className={`flex flex-col items-center ${spinning ? 'animate-pulse' : ''} cursor-pointer transition-transform ${isSelected ? 'scale-105' : 'hover:scale-105'}`}
      onClick={onClick}
    >
      <div className={`text-sm font-semibold mb-2 ${color} ${isSelected ? 'underline decoration-2 underline-offset-4' : ''}`}>{label}</div>
      <div 
        className={`relative w-48 h-48 border-4 rounded-full flex items-center justify-center bg-white shadow-lg transition-all ${isSelected ? 'ring-4 ring-offset-2 ring-red-400 border-red-600 scale-105' : ''}`} 
        style={{ borderColor: isSelected ? undefined : color.replace('text-', '') }}
      >
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
  onRingClick?: (ring: 'region' | 'taxon' | 'iucn') => void;
  selectedRing?: 'region' | 'taxon' | 'iucn' | null;
}

export const SpinnerWheels = ({
  region,
  taxon,
  iucn,
  spinning,
  regionItems,
  taxonItems,
  iucnItems,
  onRingClick,
  selectedRing,
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
      if (!selectedRing || selectedRing === 'region') {
        setRegionIndex(prev => (prev + 1) % regionItems.length);
      }
      if (!selectedRing || selectedRing === 'taxon') {
        setTaxonIndex(prev => (prev + 1) % taxonItems.length);
      }
      if (!selectedRing || selectedRing === 'iucn') {
        setIucnIndex(prev => (prev + 1) % iucnItems.length);
      }
    }, 100);

    return () => clearInterval(interval);
  }, [spinning, regionItems.length, taxonItems.length, iucnItems.length, selectedRing]);

  return (
    <div className="flex flex-wrap justify-center gap-8 my-8">
      <Ring
        items={regionItems}
        currentIndex={regionIndex}
        spinning={spinning && (!selectedRing || selectedRing === 'region')}
        label="Region"
        color="text-blue-600"
        onClick={() => onRingClick?.('region')}
        isSelected={selectedRing === 'region'}
      />
      <Ring
        items={taxonItems}
        currentIndex={taxonIndex}
        spinning={spinning && (!selectedRing || selectedRing === 'taxon')}
        label="Taxon"
        color="text-green-600"
        onClick={() => onRingClick?.('taxon')}
        isSelected={selectedRing === 'taxon'}
      />
      <Ring
        items={iucnItems}
        currentIndex={iucnIndex}
        spinning={spinning && (!selectedRing || selectedRing === 'iucn')}
        label="IUCN Status"
        color="text-red-600"
        onClick={() => onRingClick?.('iucn')}
        isSelected={selectedRing === 'iucn'}
      />
    </div>
  );
};
