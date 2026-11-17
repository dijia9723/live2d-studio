// 本文件实现 calculate 工具使用的四则运算解析器，用有理数保证小数运算精确。

package agent

import (
	"math/big"
	"strings"
)

const (
	maxCalculationBytes = 256
	invalidCalculation  = toolInputError("请输入由数字、小数点、括号和 + - * / 组成的数学表达式。")
)

// calculate 解析并计算四则运算表达式。
// 只接受数字、小数点、括号、空白与 + - * /，长度上限 256 字节；
// 结果能写成有限小数时返回小数字符串，否则返回精确分数并附 16 位有效数字的近似值。
func calculate(input string) (string, error) {
	if len(input) > maxCalculationBytes {
		return "", toolInputError("计算表达式不能超过 256 个字符。")
	}
	parser := calculationParser{input: input}
	value, err := parser.expression(1)
	if err != nil {
		return "", err
	}
	if parser.input != "" {
		return "", invalidCalculation
	}
	if digits, exact := value.FloatPrec(); exact {
		return value.FloatString(digits), nil
	}
	approximation := new(big.Float).SetRat(value).Text('g', 16)
	return value.RatString() + "（约 " + approximation + "）", nil
}

type calculationParser struct {
	input string
}

func (p *calculationParser) next() byte {
	p.input = strings.TrimLeft(p.input, " \t\n\r")
	if p.input == "" {
		return 0
	}
	return p.input[0]
}

func precedence(operator byte) int {
	switch operator {
	case '+', '-':
		return 1
	case '*', '/':
		return 2
	default:
		return 0
	}
}

func (p *calculationParser) expression(minPrecedence int) (*big.Rat, error) {
	left, err := p.operand()
	if err != nil {
		return nil, err
	}
	for {
		operator := p.next()
		level := precedence(operator)
		if level < minPrecedence {
			return left, nil
		}
		p.input = p.input[1:]
		// 同级运算符交给外层表达式处理，因此减号与除号按从左到右结合，
		// 例如 8 / 4 / 2 得到 1 而不是 4。
		right, err := p.expression(level + 1)
		if err != nil {
			return nil, err
		}
		switch operator {
		case '+':
			left.Add(left, right)
		case '-':
			left.Sub(left, right)
		case '*':
			left.Mul(left, right)
		case '/':
			if right.Sign() == 0 {
				return nil, toolInputError("除数不能为零。")
			}
			left.Quo(left, right)
		}
	}
}

func (p *calculationParser) operand() (*big.Rat, error) {
	switch operator := p.next(); operator {
	case '+', '-':
		p.input = p.input[1:]
		value, err := p.operand()
		if err != nil {
			return nil, err
		}
		if operator == '-' {
			value.Neg(value)
		}
		return value, nil
	case '(':
		p.input = p.input[1:]
		value, err := p.expression(1)
		if err != nil {
			return nil, err
		}
		if p.next() != ')' {
			return nil, invalidCalculation
		}
		p.input = p.input[1:]
		return value, nil
	default:
		return p.number()
	}
}

func (p *calculationParser) number() (*big.Rat, error) {
	end := 0
	for end < len(p.input) {
		char := p.input[end]
		if (char < '0' || char > '9') && char != '.' {
			break
		}
		end++
	}
	if end == 0 {
		return nil, invalidCalculation
	}
	literal := p.input[:end]
	p.input = p.input[end:]
	if !strings.Contains(literal, ".") {
		// big.Rat 会把带前导零的纯整数按八进制解析（如 009），补上 .0 强制按十进制处理。
		literal += ".0"
	}
	value, ok := new(big.Rat).SetString(literal)
	if !ok {
		return nil, invalidCalculation
	}
	return value, nil
}
