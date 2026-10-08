// First launch (and Settings): the guard picks English or Urdu (D-14). Shown in both languages.
import type { Locale } from '../../core/i18n/index.ts';
import { translate } from '../../core/i18n/index.ts';
import { Button, Screen, Txt } from '../components.tsx';
import { useGuardApp } from '../context.tsx';

export function LanguageScreen({ onDone }: { onDone: () => void }) {
  const app = useGuardApp();
  const choose = (locale: Locale) => {
    void app.setLocale(locale).then(onDone);
  };
  return (
    <Screen>
      <Txt kind="title" center>
        SENTRY
      </Txt>
      <Txt kind="heading" center>
        {translate('en', 'language.title')}
      </Txt>
      <Txt kind="heading" center>
        {translate('ur', 'language.title')}
      </Txt>
      <Button
        kind="secondary"
        icon="A"
        label={translate('en', 'language.english')}
        onPress={() => choose('en')}
      />
      <Button
        kind="secondary"
        icon="ا"
        label={translate('ur', 'language.urdu')}
        onPress={() => choose('ur')}
      />
    </Screen>
  );
}
