// process.env is the reliable source inside Docker; import.meta.env can be
// baked as undefined by Vite when the variable isn't in a .env file.
const BASE = (
  import.meta.env.DIRECTUS_URL ??
  process.env['DIRECTUS_URL'] ??
  'http://localhost:8055'
).replace(/\/$/, '');

const TOKEN: string =
  import.meta.env.DIRECTUS_TOKEN ||
  process.env['DIRECTUS_TOKEN'] ||
  '';

async function get<T>(path: string): Promise<T> {
  const headers: Record<string, string> = {};
  if (TOKEN) headers['Authorization'] = `Bearer ${TOKEN}`;

  const res = await fetch(`${BASE}${path}`, { headers });

  if (res.status === 403) {
    throw new Error(
      `Directus returned 403 for "${path}". ` +
      `Either set DIRECTUS_TOKEN in .env or enable public Read access: ` +
      `Directus → Settings → Roles → Public → enable Read on all collections.`,
    );
  }
  if (!res.ok) {
    throw new Error(`Directus ${path} → HTTP ${res.status}`);
  }
  return ((await res.json()) as { data: T }).data;
}

/** Renders our simple markdown subset (paragraphs + **bold**) to HTML. */
export function md(text: string | null | undefined): string {
  if (!text) return '';
  return (
    '<p>' +
    text
      .trim()
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .split(/\n\n+/)
      .join('</p><p>') +
    '</p>'
  );
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface SiteSettings {
  site_name: string;
  tagline: string;
  contact_email: string;
  contact_phone: string;
  address_street: string;
  address_zip: string;
  address_city: string;
  google_maps_url: string;
  instagram_url: string;
  facebook_url: string;
  footer_note: string;
}

export interface Hero {
  eyebrow: string;
  headline: string;
  subheadline: string;
  cta_primary_label: string;
  cta_primary_link: string;
  cta_secondary_label: string;
  cta_secondary_link: string;
  image_alt: string;
}

export interface About {
  title: string;
  subtitle: string;
  story: string;
  philosophy: string;
  founded_year: number;
  generations: number;
}

export interface Category {
  id: number;
  name: string;
  sort: number;
  description: string;
}

export interface MenuItem {
  id: number;
  name: string;
  description: string;
  price: number;
  is_vegetarian: boolean;
  is_vegan: boolean;
  available: boolean;
  is_featured: boolean;
  allergens: string[] | null;
  category: Category;
}

export interface TeamMember {
  id: number;
  first_name: string;
  last_name: string;
  role: string;
  sort: number;
  bio: string;
}

export interface Testimonial {
  id: number;
  author: string;
  location: string;
  rating: number;
  quote: string;
  sort: number;
  published_on: string;
}

export interface Event {
  id: number;
  title: string;
  subtitle: string;
  description: string;
  starts_on: string | null;
  ends_on: string | null;
  is_recurring: boolean;
  recurrence_note: string;
}

export interface OpeningHour {
  id: number;
  weekday: string;
  sort: number;
  closed: boolean;
  open_from: string;
  open_to: string;
  kitchen_from: string;
  kitchen_to: string;
  note: string;
}

export interface FaqItem {
  id: number;
  question: string;
  sort: number;
  answer: string;
}

// ── Fetch helpers ─────────────────────────────────────────────────────────────

export const getSiteSettings  = () => get<SiteSettings>('/items/site_settings');
export const getHero           = () => get<Hero>('/items/hero');
export const getAbout          = () => get<About>('/items/about');
export const getTeam           = () => get<TeamMember[]>('/items/team?sort=sort');
export const getTestimonials   = () => get<Testimonial[]>('/items/testimonials?sort=sort');
export const getOpeningHours   = () => get<OpeningHour[]>('/items/opening_hours?sort=sort');
export const getFaq            = () => get<FaqItem[]>('/items/faq?sort=sort');
export const getEvents         = () => get<Event[]>('/items/events?sort=starts_on');
export const getCategories     = () => get<Category[]>('/items/categories?sort=sort');

export const getMenuItems = () =>
  get<MenuItem[]>('/items/menu_items?fields=*,category.*&limit=-1&sort=category.sort,name');

export const getFeaturedDishes = () =>
  get<MenuItem[]>(
    '/items/menu_items?filter[is_featured][_eq]=true&fields=*,category.name&limit=6',
  );
