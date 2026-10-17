// Tether WDK is about 300 KB gzip: import the onboarding only through this loader,
// never statically, so it stays out of the main bundle.
export const loadWdkOnboarding = () => import('./WdkOnboardingSheet')
