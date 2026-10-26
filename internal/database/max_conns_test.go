package database

import "testing"

func TestParseMaxConns(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want int32
	}{
		{name: "empty", raw: "", want: 10},
		{name: "whitespace", raw: "  \t", want: 10},
		{name: "default_explicit", raw: "10", want: 10},
		{name: "min", raw: "1", want: 1},
		{name: "max", raw: "1000", want: 1000},
		{name: "mid", raw: "32", want: 32},
		{name: "padded", raw: " 64 ", want: 64},
		{name: "zero", raw: "0", want: 10},
		{name: "negative", raw: "-1", want: 10},
		{name: "above_max", raw: "1001", want: 10},
		{name: "non_integer", raw: "abc", want: 10},
		{name: "float", raw: "10.5", want: 10},
		{name: "overflow", raw: "9999999999999999999", want: 10},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := ParseMaxConns(tc.raw); got != tc.want {
				t.Fatalf("ParseMaxConns(%q)=%d want %d", tc.raw, got, tc.want)
			}
		})
	}
}
