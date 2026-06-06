import type { TcoInputs } from '../types';

// Representative central/low/high TCO inputs (USD/yr) for a fictional reference customer
// ("Northwind Mutual Insurance") — illustrative figures used to pin the golden tests; not a real customer.
export const NORTHWIND: TcoInputs = {
  onpremComponents: {
    license: { low: 135000, central: 240000, high: 450000 },
    hardware: { low: 40000, central: 58000, high: 121000 },
    storage: { low: 5000, central: 22000, high: 95000 },
    facility: { low: 31500, central: 49500, high: 99000 },
    labor: { low: 35000, central: 70000, high: 135000 },
    backup: { low: 5000, central: 10000, high: 20000 },
  },
  adbPrimary: { low: 78525, central: 80926, high: 100000 },
  coldDrAdd: { low: 18774, central: 26820, high: 40231 },
  warmDrAdd: { low: 128481, central: 132723, high: 142620 },
  migrationPs: { low: 75000, central: 150000, high: 300000 },
};
