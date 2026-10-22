export interface HolidayEvent {
  country: string;
  countryLabel: string;
  name: string;
  date: string;
  startAt: string;
  endAt: string;
  timeZone: string;
  kind: 'public' | 'bank';
  substitute: boolean;
}
