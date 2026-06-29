import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import i18n, { DEFAULT_LANGUAGE, LANG_STORAGE_KEY, type Language } from "../i18n";

// Calque exact de ThemeContext : état local + persistance localStorage.
// La seule différence est l'effet de bord i18n.changeLanguage() au setter.
interface LanguageContextValue {
  language: Language;
  setLanguage: (language: Language) => void;
}

const LanguageContext = createContext<LanguageContextValue>({
  language: DEFAULT_LANGUAGE,
  setLanguage: () => {},
});

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>(
    () => (i18n.language as Language) || DEFAULT_LANGUAGE
  );

  const setLanguage = (newLanguage: Language) => {
    setLanguageState(newLanguage);
    localStorage.setItem(LANG_STORAGE_KEY, newLanguage);
    i18n.changeLanguage(newLanguage);
  };

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  return (
    <LanguageContext.Provider value={{ language, setLanguage }}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguage() {
  return useContext(LanguageContext);
}
