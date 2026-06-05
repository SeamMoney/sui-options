'use client';
import { PhoneFrame, SimReturnsSheet } from '@/components/mobile/OptionsAnalyzer';

const defaultContract = {
  strike: 105,
  price: 0.05,
  today: 0.12,
};

export default function Page() {
  return (
    <PhoneFrame>
      <SimReturnsSheet
        contract={defaultContract}
        onBack={() => history.back()}
        onContinue={() => {}}
      />
    </PhoneFrame>
  );
}
