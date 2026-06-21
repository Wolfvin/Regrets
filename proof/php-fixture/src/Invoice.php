<?php declare(strict_types=1);
/**
 * Invoice.php — class-based fixture for the PHP Regrets verification.
 *
 * Demonstrates: instance method, constructorArgs, multiArgs.
 * The entry method `Invoice::calculate` takes (array $items, float $discount)
 * and returns an associative array with subtotal/discount/tax/total.
 */

class Invoice
{
    private float $taxRate;

    public function __construct(float $taxRate = 0.10)
    {
        if ($taxRate < 0 || $taxRate > 1) {
            throw new \InvalidArgumentException("taxRate must be between 0 and 1");
        }
        $this->taxRate = $taxRate;
    }

    /**
     * Calculate the invoice total for a list of line items plus optional discount.
     *
     * @param array<int, array{price: float, qty: int}> $items
     * @param float $discount  fractional discount applied to subtotal (0.0 = none)
     * @return array{subtotal: float, discount: float, tax: float, total: float}
     */
    public function calculate(array $items, float $discount = 0.0): array
    {
        $subtotal = 0.0;
        foreach ($items as $item) {
            $subtotal += (float) $item['price'] * (int) $item['qty'];
        }
        $discountAmount = $subtotal * $discount;
        $taxable = $subtotal - $discountAmount;
        $tax = $taxable * $this->taxRate;
        return [
            'subtotal' => $subtotal,
            'discount' => $discountAmount,
            'tax'      => $tax,
            'total'    => $taxable + $tax,
        ];
    }

    /**
     * Return the configured tax rate (informational — not used as entry).
     */
    public function getTaxRate(): float
    {
        return $this->taxRate;
    }
}
