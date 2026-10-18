// Tether WDK is about 300 KB gzip: import the onboarding only through these loaders,
// never statically, so it stays out of the main bundle.
export const loadWdkOnboarding = () => import('./WdkOnboardingSheet')
export const loadVaultOnboarding = () => import('./VaultOnboardingSheet')
