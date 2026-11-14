"""Illustrative linear-perpetual economics. NOT an exchange liquidation calculator."""
from dataclasses import dataclass

@dataclass
class Scenario:
    entry: float
    reference: float
    pnl: float
    leverage: float
    direction: str

    def analyze(self):
        delta = (self.reference - self.entry) * (1 if self.direction == 'long' else -1)
        if self.entry <= 0 or delta <= 0 or self.leverage <= 0:
            raise ValueError('Expected positive entry, favorable reference move and leverage')
        quantity = self.pnl / delta
        notional = quantity * self.entry
        return dict(quantity=quantity, entry_notional=notional,
                    nominal_initial_margin=notional/self.leverage,
                    underlying_move_pct=100*delta/self.entry,
                    margin_exhaustion_reference=self.entry*(1-1/self.leverage if self.direction=='long' else 1+1/self.leverage))

if __name__ == '__main__':
    examples = {'BTC': Scenario(62038.4,58186.1,414558.5597,20,'short'),
                'ZEC': Scenario(513.23,417.14,229504.0582,20,'short'),
                'XRP': Scenario(1.2947,1.3349,213867.1035,20,'long'),
                'NVDA': Scenario(182.89297,174.06521,114388.53,10,'short')}
    for symbol, trade in examples.items():
        print(symbol, trade.analyze())
